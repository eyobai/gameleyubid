import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { CurrentUser } from '../common/auth';
import type { AuthUser } from '../common/auth';
import { formatMinor } from '../common/money';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { delta } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';

class HistoryQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** The `sequence` of the last item of the previous page. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before?: number;
}

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async balance(@CurrentUser() user: AuthUser) {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { userId: user.id } });
    const balance = account?.balanceMinor ?? 0n;
    return {
      currency: this.config.currency.code,
      minorUnits: this.config.currency.minorUnits,
      balanceMinor: balance.toString(),
      balance: formatMinor(balance, this.config.currency.minorUnits),
    };
  }

  @Get('transactions')
  async history(@CurrentUser() user: AuthUser, @Query() q: HistoryQuery) {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { userId: user.id } });
    if (!account) return { items: [] };
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { accountId: account.id, ...(q.before ? { sequence: { lt: BigInt(q.before) } } : {}) },
      include: { journal: true },
      orderBy: { sequence: 'desc' },
      take: q.limit ?? 30,
    });
    const money = (v: bigint) => formatMinor(v, this.config.currency.minorUnits);
    return {
      items: entries.map((e) => {
        const change = delta(account.type, e);
        return {
          sequence: e.sequence.toString(),
          type: e.journal.type,
          reference: e.journal.reference,
          description: e.journal.description,
          changeMinor: change.toString(),
          change: money(change),
          balanceAfterMinor: e.balanceAfterMinor.toString(),
          balanceAfter: money(e.balanceAfterMinor),
          createdAt: e.createdAt.toISOString(),
        };
      }),
    };
  }
}
