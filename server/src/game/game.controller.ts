import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser, IdempotencyKey, Public } from '../common/auth';
import type { AuthUser } from '../common/auth';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { roundCrashX100, sha256 } from './fairness';
import { GameService } from './game.service';

class PlaceBetDto {
  /** Integer minor units as text, e.g. "5000" for 50.00. */
  @IsString()
  @Matches(/^[1-9]\d{0,14}$/)
  betMinor: string;

  @IsOptional()
  @IsInt()
  @Min(101)
  autoCashoutX100?: number;

  /** 1 or 2: a player can have two bets in the same round. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2)
  slot?: number;
}

class TopQuery {
  @IsOptional()
  @IsIn(['multiplier', 'win'])
  by?: 'multiplier' | 'win';

  @IsOptional()
  @IsIn(['day', 'month', 'year'])
  period?: 'day' | 'month' | 'year';
}

class LimitQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before?: number;
}

class VerifyQuery {
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  seed: string;

  @IsString()
  @Length(1, 100)
  salt: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  edgeBps: number;
}

@Controller('game')
export class GameController {
  constructor(private readonly game: GameService) {}

  @Public()
  @Get('info')
  info() {
    return this.game.info();
  }

  /** The round in progress, everyone's bets in it, recent pop points and my own bet. Poll a few times a second. */
  @Get('live')
  live(@CurrentUser() user: AuthUser) {
    return this.game.live(user.id);
  }

  @Post('bets')
  async place(@CurrentUser() user: AuthUser, @Body() dto: PlaceBetDto, @IdempotencyKey() key: string, @Res({ passthrough: true }) res: Response) {
    const { bet, replayed } = await this.game.placeBet(user, BigInt(dto.betMinor), dto.autoCashoutX100 ?? null, key, dto.slot ?? 1);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return bet;
  }

  @Get('bets')
  mine(@CurrentUser() user: AuthUser, @Query() q: LimitQuery) {
    return this.game.listMine(user.id, q.limit);
  }

  @Get('bets/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.game.getBet(user, id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('bets/:id/cash-out')
  cashOut(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.game.cashOut(user, id);
  }

  /** Withdraws a bet before lift-off and returns it in full. */
  @HttpCode(HttpStatus.OK)
  @Post('bets/:id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.game.cancelBet(user, id);
  }

  /** Biggest wins, by multiplier or amount, over a day, month or year. */
  @Public()
  @Get('top')
  top(@Query() q: TopQuery) {
    return this.game.top(q.by ?? 'win', q.period ?? 'day');
  }

  /** Ended rounds with their seeds. */
  @Public()
  @Get('rounds')
  rounds(@Query() q: LimitQuery) {
    return this.game.rounds(q.limit, q.before);
  }

  /** Published commitments of every seed chain. */
  @Public()
  @Get('chains')
  chains() {
    return this.game.chains();
  }

  /** Recomputes a round from its seed. The same formula is published so anyone can check it themselves. */
  @Public()
  @Get('verify')
  verify(@Query() q: VerifyQuery) {
    return { previousSeed: sha256(q.seed), crashX100: roundCrashX100(q.seed, q.salt, q.edgeBps).toString() };
  }
}

/** Runs the round engine on a timer. */
@Injectable()
export class RoundEngine implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('RoundEngine');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly game: GameService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.game.tickMs;
    if (every <= 0) return;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.game.tick();
    } catch (e) {
      this.logger.error(e instanceof Error ? e.message : String(e));
    } finally {
      this.running = false;
    }
  }
}
