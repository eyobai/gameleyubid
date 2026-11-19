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
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser, IdempotencyKey, Public } from '../common/auth';
import type { AuthUser } from '../common/auth';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { CLIENT_SEED_PATTERN, crashPointX100, hashSeed } from './fairness';
import { GameService } from './game.service';

class StartFlightDto {
  /** Integer minor units as text, e.g. "5000" for 50.00. */
  @IsString()
  @Matches(/^[1-9]\d{0,14}$/)
  betMinor: string;

  @IsOptional()
  @IsInt()
  @Min(101)
  autoCashoutX100?: number;
}

class RotateSeedsDto {
  @IsOptional()
  @IsString()
  @Matches(CLIENT_SEED_PATTERN)
  clientSeed?: string;
}

class ListQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  before?: string;
}

class VerifyQuery {
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  serverSeed: string;

  @IsString()
  @Matches(CLIENT_SEED_PATTERN)
  clientSeed: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  nonce: number;

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

  /** Recomputes a pop point from revealed seeds. The same formula is published so anyone can check it themselves. */
  @Public()
  @Get('verify')
  verify(@Query() q: VerifyQuery) {
    const crash = crashPointX100(q.serverSeed, q.clientSeed, q.nonce, q.edgeBps);
    return { serverSeedHash: hashSeed(q.serverSeed), crashX100: crash.toString() };
  }

  @Get('seeds')
  seeds(@CurrentUser() user: AuthUser) {
    return this.game.seeds(user.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('seeds/rotate')
  rotate(@CurrentUser() user: AuthUser, @Body() dto: RotateSeedsDto) {
    return this.game.rotateSeeds(user.id, dto.clientSeed);
  }

  @Post('flights')
  async start(
    @CurrentUser() user: AuthUser,
    @Body() dto: StartFlightDto,
    @IdempotencyKey() key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { flight, replayed } = await this.game.start(user, BigInt(dto.betMinor), dto.autoCashoutX100 ?? null, key);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return flight;
  }

  @Get('flights')
  list(@CurrentUser() user: AuthUser, @Query() q: ListQuery) {
    return this.game.listMine(user.id, q.limit, q.before);
  }

  @Get('flights/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.game.get(user, id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('flights/:id/cash-out')
  cashOut(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.game.cashOut(user, id);
  }
}

/** Settles flights that reached their auto cash-out, their limit or their pop while nobody was asking. */
@Injectable()
export class SettlementWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Settlement');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly game: GameService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.game.settleIntervalMs;
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
      await this.game.settleDue();
    } catch (e) {
      this.logger.error(e instanceof Error ? e.message : String(e));
    } finally {
      this.running = false;
    }
  }
}
