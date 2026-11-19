import { Body, Controller, Get, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AccountStatus, AccountType, BetStatus, JournalType, Prisma, Role, RoundStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { CurrentUser, IdempotencyKey, Roles } from '../common/auth';
import type { AuthUser } from '../common/auth';
import { AppException, ErrorCode, notFound } from '../common/errors';
import { formatMinor } from '../common/money';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { GameService } from '../game/game.service';
import { currentLimits } from '../game/risk';
import { delta, LedgerService } from '../ledger/ledger.service';
import { MONEY_TX, PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';

class ReserveMoveDto {
  @IsString()
  @Matches(/^[1-9]\d{0,14}$/)
  amountMinor: string;

  @IsString()
  @Length(3, 300)
  reason: string;
}

class BetsQuery {
  @IsOptional()
  @IsIn(Object.values(BetStatus))
  status?: BetStatus;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class PlayersQuery {
  @IsOptional()
  @IsString()
  @Length(1, 20)
  phone?: string;
}

class BlockDto {
  @IsString()
  @Length(3, 300)
  reason: string;
}

@Controller('admin')
@Roles(Role.FINANCE)
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly game: GameService,
    private readonly payments: PaymentsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private money = (v: bigint) => formatMinor(v, this.config.currency.minorUnits);

  /** The reserve, what it has promised to open flights, current limits and the game's results by period. */
  @Get('summary')
  async summary() {
    return this.prisma.$transaction(
      async (tx) => {
        const state = await this.game.reserveState(tx);
        const g = this.config.game;
        const limits = currentLimits({ ...state, openRiskMinor: 0n }, {
          flightRiskBps: g.flightRiskBps,
          totalRiskBps: g.totalRiskBps,
          maxMultiplierX100: g.maxMultiplierX100,
          minBetMinor: g.minBetMinor,
          maxBetMinor: g.maxBetMinor,
        });
        const periods = { last24h: "24 hours", last7d: "7 days", last30d: "30 days", allTime: null } as const;
        const results: Record<string, unknown> = {};
        for (const [name, span] of Object.entries(periods)) {
          const since = span === null ? Prisma.sql`'-infinity'::timestamptz` : Prisma.sql`now() - ${span}::interval`;
          const [r] = await tx.$queryRaw<{ flights: bigint; rounds: bigint; wins: bigint; bets: bigint; payouts: bigint; players: bigint }[]>`
            SELECT COUNT(*)::bigint AS flights,
                   COUNT(DISTINCT round_id)::bigint AS rounds,
                   COUNT(*) FILTER (WHERE status = 'CASHED_OUT')::bigint AS wins,
                   COALESCE(SUM(bet_minor), 0)::bigint AS bets,
                   COALESCE(SUM(payout_minor), 0)::bigint AS payouts,
                   COUNT(DISTINCT user_id)::bigint AS players
            FROM bets WHERE status <> 'OPEN' AND settled_at >= ${since}`;
          const revenue = r.bets - r.payouts;
          results[name] = {
            /** Bets settled in the period. */
            flights: Number(r.flights),
            rounds: Number(r.rounds),
            players: Number(r.players),
            playerWinRate: r.flights ? Number(r.wins) / Number(r.flights) : null,
            betsMinor: r.bets.toString(),
            bets: this.money(r.bets),
            payoutsMinor: r.payouts.toString(),
            payouts: this.money(r.payouts),
            revenueMinor: revenue.toString(),
            revenue: this.money(revenue),
            /** Share of bets the house kept. Expected to approach the edge over many flights. */
            holdRate: r.bets ? Number(revenue) / Number(r.bets) : null,
          };
        }
        const openCount = await tx.bet.count({ where: { status: BetStatus.OPEN } });
        const current = await tx.round.findFirst({ where: { status: { not: RoundStatus.ENDED } }, include: { _count: { select: { bets: true } } } });
        return {
          currency: this.config.currency.code,
          settings: {
            enabled: g.enabled,
            edgeBps: g.edgeBps,
            flightRiskBps: g.flightRiskBps,
            totalRiskBps: g.totalRiskBps,
            maxMultiplierX100: g.maxMultiplierX100,
            minBetMinor: g.minBetMinor.toString(),
            maxBetMinor: g.maxBetMinor.toString(),
          },
          currentRound: current && {
            number: current.number,
            status: current.status,
            players: current._count.bets,
            capX100: current.capX100,
          },
          reserve: {
            balanceMinor: state.reserveMinor.toString(),
            balance: this.money(state.reserveMinor),
            committedMinor: state.committedMinor.toString(),
            committed: this.money(state.committedMinor),
            freeMinor: limits.freeMinor.toString(),
            free: this.money(limits.freeMinor),
            openFlights: openCount,
            openRiskMinor: state.openRiskMinor.toString(),
            openRisk: this.money(state.openRiskMinor),
            maxBetNowMinor: limits.maxBetMinor.toString(),
            maxBetNow: this.money(limits.maxBetMinor),
          },
          results,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** Owners put money into the reserve. */
  @Post('reserve/fund')
  fund(@CurrentUser() actor: AuthUser, @Body() dto: ReserveMoveDto, @IdempotencyKey() key: string) {
    return this.moveReserve(actor, BigInt(dto.amountMinor), dto.reason, key, 'fund');
  }

  /** Owners take money out of the reserve. Never below what open flights could still win. */
  @Post('reserve/withdraw')
  withdraw(@CurrentUser() actor: AuthUser, @Body() dto: ReserveMoveDto, @IdempotencyKey() key: string) {
    return this.moveReserve(actor, BigInt(dto.amountMinor), dto.reason, key, 'withdraw');
  }

  private moveReserve(actor: AuthUser, amount: bigint, reason: string, key: string, kind: 'fund' | 'withdraw') {
    return this.prisma.$transaction(async (tx) => {
      // Same lock as new flights: a withdrawal and a bet cannot both use the same free money.
      await tx.$queryRaw`SELECT id FROM game_state WHERE id = 1 FOR UPDATE`;
      const reserve = await this.ledger.system(tx, AccountType.GAME_RESERVE);
      const owners = await this.ledger.system(tx, AccountType.OWNER_FUNDS);
      if (kind === 'withdraw') {
        await tx.$queryRaw`SELECT id FROM ledger_accounts WHERE id = ANY(${[reserve.id, owners.id]}::uuid[]) ORDER BY id FOR UPDATE`;
        const state = await this.game.reserveState(tx);
        const free = state.reserveMinor - state.committedMinor;
        if (amount > free) {
          throw new AppException(HttpStatus.CONFLICT, ErrorCode.RESERVE_TOO_LOW, `Only ${this.money(free > 0n ? free : 0n)} is free; the rest covers open flights`, {
            freeMinor: (free > 0n ? free : 0n).toString(),
          });
        }
      }
      const [from, to] = kind === 'fund' ? [owners, reserve] : [reserve, owners];
      const posted = await this.ledger.transfer(tx, from, to, amount, {
        type: kind === 'fund' ? JournalType.RESERVE_FUNDING : JournalType.RESERVE_WITHDRAWAL,
        idempotencyKey: `reserve:${key}`,
        description: reason,
        createdById: actor.id,
      });
      if (!posted.replayed) {
        await tx.auditLog.create({
          data: { actorId: actor.id, action: `reserve.${kind}`, entity: 'GAME_RESERVE', details: { amountMinor: amount.toString(), reason, journal: posted.journal.reference } },
        });
      }
      const after = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: reserve.id } });
      return { journal: posted.journal.reference, replayed: posted.replayed, reserveMinor: after.balanceMinor.toString(), reserve: this.money(after.balanceMinor) };
    }, MONEY_TX);
  }

  @Get('bets')
  async bets(@Query() q: BetsQuery) {
    const rows = await this.prisma.bet.findMany({
      where: { status: q.status, userId: q.userId },
      include: { round: true, user: { select: { phoneNumber: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 50,
    });
    return { items: rows.map((b) => ({ ...this.game.toDto(b), userId: b.userId, phoneNumber: b.user.phoneNumber })) };
  }

  @Get('deposits')
  async deposits() {
    const rows = await this.prisma.deposit.findMany({ include: { user: { select: { phoneNumber: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { items: rows.map((d) => ({ ...this.payments.toDto(d), phoneNumber: d.user.phoneNumber, reviewReason: d.reviewReason })) };
  }

  @Get('reserve/history')
  async reserveHistory() {
    const reserve = await this.prisma.ledgerAccount.findUnique({ where: { code: AccountType.GAME_RESERVE } });
    if (!reserve) return { items: [] };
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { accountId: reserve.id, journal: { type: { in: [JournalType.RESERVE_FUNDING, JournalType.RESERVE_WITHDRAWAL] } } },
      include: { journal: true },
      orderBy: { sequence: 'desc' },
      take: 50,
    });
    return {
      items: entries.map((e) => ({
        reference: e.journal.reference,
        type: e.journal.type,
        reason: e.journal.description,
        change: this.money(delta(reserve.type, e)),
        balanceAfter: this.money(e.balanceAfterMinor),
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  /** Recomputes every balance from the ledger lines and checks that the books balance. */
  @Get('ledger/reconciliation')
  async reconciliation() {
    return this.prisma.$transaction(
      async (tx) => {
        const mismatches = await tx.$queryRaw<{ code: string; cached: bigint; computed: bigint }[]>`
          SELECT a.code, a.balance_minor AS cached,
                 COALESCE(SUM(CASE WHEN (e.direction = 'DEBIT') = (a.type = 'PAYMENT_CLEARING') THEN e.amount_minor ELSE -e.amount_minor END), 0)::bigint AS computed
          FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
          GROUP BY a.id HAVING a.balance_minor <> COALESCE(SUM(CASE WHEN (e.direction = 'DEBIT') = (a.type = 'PAYMENT_CLEARING') THEN e.amount_minor ELSE -e.amount_minor END), 0)`;
        const [trial] = await tx.$queryRaw<{ total: bigint }[]>`
          SELECT COALESCE(SUM(CASE WHEN type = 'PAYMENT_CLEARING' THEN -balance_minor ELSE balance_minor END), 0)::bigint AS total FROM ledger_accounts`;
        const [flights] = await tx.$queryRaw<{ bad: bigint }[]>`
          SELECT COUNT(*)::bigint AS bad FROM bets b
          LEFT JOIN journals p ON p.id = b.payout_journal_id
          WHERE b.status = 'CASHED_OUT' AND (p.amount_minor IS DISTINCT FROM b.payout_minor)`;
        return {
          ok: mismatches.length === 0 && trial.total === 0n && flights.bad === 0n,
          accountMismatches: mismatches.map((m) => ({ code: m.code, cachedMinor: m.cached.toString(), computedMinor: m.computed.toString() })),
          trialBalanceMinor: trial.total.toString(),
          betsWithWrongPayout: Number(flights.bad),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  @Roles(Role.ADMIN)
  @Get('players')
  async players(@Query() q: PlayersQuery) {
    const rows = await this.prisma.user.findMany({
      where: { role: Role.PLAYER, ...(q.phone ? { phoneNumber: { contains: q.phone.replace(/\D/g, '') } } : {}) },
      include: { account: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      items: rows.map((u) => ({
        id: u.id,
        phoneNumber: u.phoneNumber,
        status: u.status,
        balance: this.money(u.account?.balanceMinor ?? 0n),
        createdAt: u.createdAt.toISOString(),
      })),
    };
  }

  @Roles(Role.ADMIN)
  @Post('players/:id/block')
  block(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BlockDto) {
    return this.setStatus(actor, id, AccountStatus.BLOCKED, dto.reason);
  }

  @Roles(Role.ADMIN)
  @Post('players/:id/unblock')
  unblock(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BlockDto) {
    return this.setStatus(actor, id, AccountStatus.ACTIVE, dto.reason);
  }

  private async setStatus(actor: AuthUser, id: string, status: AccountStatus, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user || user.role !== Role.PLAYER) throw notFound('Player not found');
      await tx.user.update({ where: { id }, data: { status } });
      if (status === AccountStatus.BLOCKED) {
        await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await tx.auditLog.create({ data: { actorId: actor.id, action: `player.${status.toLowerCase()}`, entity: id, details: { reason } } });
      return { id, status };
    });
  }
}
