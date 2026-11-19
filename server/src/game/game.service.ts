import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AccountType, FlightStatus, JournalType } from '@prisma/client';
import type { Flight, SeedPair } from '@prisma/client';
import { createHash } from 'node:crypto';
import { isStaff } from '../common/auth';
import type { AuthUser } from '../common/auth';
import { AppException, ErrorCode, notFound } from '../common/errors';
import { formatMinor, formatX100 } from '../common/money';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { LedgerService } from '../ledger/ledger.service';
import { MONEY_TX, PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/prisma.service';
import { CLIENT_SEED_PATTERN, crashPointX100, hashSeed, newClientSeed, newServerSeed } from './fairness';
import { GROWTH_PER_SECOND, multiplierAt, payoutFor, plannedOutcome } from './flight-math';
import type { CashoutReason } from './flight-math';
import { checkBet, currentLimits } from './risk';
import type { ReserveState, RiskSettings } from './risk';

type FlightWithSeed = Flight & { seedPair: SeedPair };

export interface FlightDto {
  id: string;
  status: FlightStatus;
  currency: string;
  betMinor: string;
  bet: string;
  autoCashoutX100: number | null;
  capX100: number;
  cap: string;
  maxPayoutMinor: string;
  startedAt: string;
  serverTime: string;
  /** Multiplier ×100 at serverTime, while the flight is open. */
  multiplierX100: number | null;
  cashoutX100: number | null;
  cashoutReason: string | null;
  payoutMinor: string | null;
  payout: string | null;
  profitMinor: string | null;
  /** Revealed once the flight is settled. */
  crashX100: string | null;
  crash: string | null;
  settledAt: string | null;
  fairness: { serverSeedHash: string; clientSeed: string; nonce: number; edgeBps: number; serverSeed: string | null };
}

export interface SeedsDto {
  serverSeedHash: string;
  clientSeed: string;
  nextNonce: number;
}

const flightInclude = { seedPair: true } as const;

@Injectable()
export class GameService {
  private readonly logger = new Logger('Game');
  private readonly risk: RiskSettings;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    const g = config.game;
    this.risk = {
      flightRiskBps: g.flightRiskBps,
      totalRiskBps: g.totalRiskBps,
      maxMultiplierX100: g.maxMultiplierX100,
      minBetMinor: g.minBetMinor,
      maxBetMinor: g.maxBetMinor,
    };
  }

  /** Public rules and today's bet limit. */
  async info() {
    const state = await this.prisma.$transaction((tx) => this.reserveState(tx));
    const limits = currentLimits(state, this.risk);
    const money = (v: bigint) => formatMinor(v, this.config.currency.minorUnits);
    return {
      enabled: this.config.game.enabled,
      currency: this.config.currency.code,
      minorUnits: this.config.currency.minorUnits,
      edgeBps: this.config.game.edgeBps,
      minBetMinor: this.risk.minBetMinor.toString(),
      minBet: money(this.risk.minBetMinor),
      maxBetMinor: limits.maxBetMinor.toString(),
      maxBet: money(limits.maxBetMinor),
      maxMultiplierX100: this.risk.maxMultiplierX100,
      flightRiskBps: this.risk.flightRiskBps,
      growthPerSecond: GROWTH_PER_SECOND,
      serverTime: new Date().toISOString(),
    };
  }

  async seeds(userId: string): Promise<SeedsDto> {
    const pair = await this.prisma.$transaction((tx) => this.activePair(tx, userId, false));
    return { serverSeedHash: pair.serverSeedHash, clientSeed: pair.clientSeed, nextNonce: pair.nextNonce };
  }

  /** Retires the current pair, revealing its server seed, and starts a new one. Not while a flight is open. */
  async rotateSeeds(userId: string, clientSeed?: string) {
    if (clientSeed !== undefined && !CLIENT_SEED_PATTERN.test(clientSeed)) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'Use 1 to 64 letters, digits, - or _');
    }
    return this.prisma.$transaction(async (tx) => {
      const old = await this.activePair(tx, userId, true);
      const open = await tx.flight.count({ where: { userId, status: FlightStatus.OPEN } });
      if (open) throw new AppException(HttpStatus.CONFLICT, ErrorCode.FLIGHT_IN_PROGRESS, 'Finish your flight first');
      await tx.seedPair.update({ where: { id: old.id }, data: { active: false, revealedAt: new Date() } });
      const fresh = await this.createPair(tx, userId, clientSeed);
      return {
        previous: {
          serverSeed: old.serverSeed,
          serverSeedHash: old.serverSeedHash,
          clientSeed: old.clientSeed,
          flights: old.nextNonce,
        },
        current: { serverSeedHash: fresh.serverSeedHash, clientSeed: fresh.clientSeed, nextNonce: fresh.nextNonce },
      };
    });
  }

  /**
   * Takes the bet and launches a flight, as one transaction. The pop point, the cap and the moment the flight
   * settles are all fixed here; nothing the player sends later can change them.
   */
  async start(user: AuthUser, betMinor: bigint, autoX100: number | null, key: string): Promise<{ flight: FlightDto; replayed: boolean }> {
    if (!this.config.game.enabled) {
      throw new AppException(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.GAME_DISABLED, 'The game is closed right now');
    }
    if (isStaff(user.role)) throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, 'Staff accounts cannot play');
    if (autoX100 !== null && (autoX100 < 101 || autoX100 > this.risk.maxMultiplierX100)) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'Auto cash-out must be between 1.01× and the maximum multiplier');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`flight:${user.id}:${key}`}, 0))::text`;
      const earlier = await tx.flight.findUnique({
        where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: key } },
        include: flightInclude,
      });
      if (earlier) {
        if (earlier.betMinor !== betMinor || earlier.autoCashoutX100 !== autoX100) {
          throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.IDEMPOTENCY_KEY_REUSED, 'This idempotency key was already used for a different bet');
        }
        return { flight: this.toDto(earlier, await this.now(tx)), replayed: true };
      }

      // Every new commitment of the reserve takes this lock, so limits are checked against a settled picture.
      await tx.$queryRaw`SELECT id FROM game_state WHERE id = 1 FOR UPDATE`;

      const open = await this.lockOpenFlightOf(tx, user.id);
      if (open) {
        const settled = await this.settleLocked(tx, open, null);
        if (settled.status === FlightStatus.OPEN) {
          throw new AppException(HttpStatus.CONFLICT, ErrorCode.FLIGHT_IN_PROGRESS, 'Your balloon is still flying', { flightId: open.id });
        }
      }

      const wallet = await this.ledger.wallet(tx, user.id);
      const reserve = await this.ledger.system(tx, AccountType.GAME_RESERVE);
      // Same order as the ledger (by id), so this cannot deadlock with a payout.
      await tx.$queryRaw`SELECT id FROM ledger_accounts WHERE id = ANY(${[wallet.id, reserve.id]}::uuid[]) ORDER BY id FOR UPDATE`;

      const state = await this.reserveState(tx);
      const check = checkBet(betMinor, state, this.risk);
      if (!check.ok) {
        const money = (v: bigint) => formatMinor(v, this.config.currency.minorUnits);
        if (check.reason === 'BELOW_MIN') {
          throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.BET_TOO_SMALL, `The smallest bet is ${money(this.risk.minBetMinor)}`, {
            minBetMinor: this.risk.minBetMinor.toString(),
          });
        }
        throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.BET_ABOVE_LIMIT, `The largest bet right now is ${money(check.limits.maxBetMinor)}`, {
          maxBetMinor: check.limits.maxBetMinor.toString(),
        });
      }

      const pair = await this.activePair(tx, user.id, true);
      const nonce = pair.nextNonce;
      await tx.seedPair.update({ where: { id: pair.id }, data: { nextNonce: { increment: 1 } } });
      const edgeBps = this.config.game.edgeBps;
      const crashX100 = crashPointX100(pair.serverSeed, pair.clientSeed, nonce, edgeBps);

      const bet = await this.ledger.transfer(tx, wallet, reserve, betMinor, {
        type: JournalType.BET,
        idempotencyKey: `bet:${createHash('sha256').update(`${user.id}|${key}`).digest('hex')}`,
        description: 'Updraft bet',
        createdById: user.id,
      });
      if (bet.replayed) throw new Error('A bet journal exists without its flight');

      const now = await this.now(tx);
      const planned = plannedOutcome(crashX100, check.capX100, autoX100);
      const created = await tx.flight.create({
        data: {
          userId: user.id,
          idempotencyKey: key,
          seedPairId: pair.id,
          nonce,
          edgeBps,
          betMinor,
          autoCashoutX100: autoX100,
          capX100: check.capX100,
          maxPayoutMinor: check.maxPayoutMinor,
          crashX100,
          startedAt: now,
          settleAt: new Date(now.getTime() + planned.afterMs),
          betJournalId: bet.journal.id,
        },
        include: flightInclude,
      });
      // A flight that pops at 1.00× is decided the moment it starts.
      const result = planned.afterMs === 0 ? await this.settleLocked(tx, created, null) : created;
      return { flight: this.toDto(result, now), replayed: false };
    }, MONEY_TX);
  }

  /** Cashes out at the multiplier the server clock shows now, if the balloon has not popped. */
  async cashOut(user: AuthUser, flightId: string): Promise<FlightDto> {
    return this.prisma.$transaction(async (tx) => {
      const flight = await this.lockFlight(tx, flightId, user.id);
      if (!flight) throw notFound('Flight not found');
      if (flight.status !== FlightStatus.OPEN) {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.FLIGHT_SETTLED, 'This flight is already over', {
          flight: this.toDto(flight, await this.now(tx)),
        });
      }
      const settled = await this.settleLocked(tx, flight, 'PLAYER');
      return this.toDto(settled, await this.now(tx));
    }, MONEY_TX);
  }

  /** One of my flights; settles it first if its outcome is already decided. */
  async get(user: AuthUser, flightId: string): Promise<FlightDto> {
    return this.prisma.$transaction(async (tx) => {
      const flight = await this.lockFlight(tx, flightId, user.id);
      if (!flight) throw notFound('Flight not found');
      const current = flight.status === FlightStatus.OPEN ? await this.settleLocked(tx, flight, null) : flight;
      return this.toDto(current, await this.now(tx));
    }, MONEY_TX);
  }

  async listMine(userId: string, limit = 20, before?: string) {
    const flights = await this.prisma.flight.findMany({
      where: { userId, ...(before ? { startedAt: { lt: new Date(before) } } : {}) },
      include: flightInclude,
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    const now = new Date();
    return { items: flights.map((f) => this.toDto(f, now)) };
  }

  /** Background job: settles flights whose outcome time has passed (auto cash-outs, limits, pops). */
  async settleDue(batch = 100): Promise<number> {
    const due = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM flights WHERE status = 'OPEN' AND settle_at <= clock_timestamp() ORDER BY settle_at LIMIT ${batch}`;
    let settled = 0;
    for (const { id } of due) {
      try {
        const done = await this.prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM flights WHERE id = ${id}::uuid AND status = 'OPEN' FOR UPDATE SKIP LOCKED`;
          if (!rows.length) return false;
          const flight = await tx.flight.findUniqueOrThrow({ where: { id }, include: flightInclude });
          return (await this.settleLocked(tx, flight, null)).status !== FlightStatus.OPEN;
        }, MONEY_TX);
        if (done) settled++;
      } catch (e) {
        this.logger.error(`Could not settle flight ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return settled;
  }

  /** Reserve balance and what open flights could still take from it. Read under the caller's locks. */
  async reserveState(tx: Tx): Promise<ReserveState> {
    const reserve = await this.ledger.system(tx, AccountType.GAME_RESERVE);
    const [row] = await tx.$queryRaw<{ bets: bigint; committed: bigint; risk: bigint }[]>`
      SELECT COALESCE(SUM(bet_minor), 0)::bigint AS bets,
             COALESCE(SUM(max_payout_minor), 0)::bigint AS committed,
             COALESCE(SUM(max_payout_minor - bet_minor), 0)::bigint AS risk
      FROM flights WHERE status = 'OPEN'`;
    const fresh = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: reserve.id } });
    return { reserveMinor: fresh.balanceMinor, openBetsMinor: row.bets, committedMinor: row.committed, openRiskMinor: row.risk };
  }

  /**
   * Decides a locked, open flight. `PLAYER` means the player asked to cash out now; null means only settle if the
   * outcome time has passed. Past that time the planned outcome applies, whatever the request.
   */
  private async settleLocked(tx: Tx, flight: FlightWithSeed, request: 'PLAYER' | null): Promise<FlightWithSeed> {
    if (flight.status !== FlightStatus.OPEN) return flight;
    const now = await this.now(tx);
    let win: { x100: number; reason: CashoutReason } | null = null;
    let bust = false;

    if (now >= flight.settleAt) {
      const planned = plannedOutcome(flight.crashX100, flight.capX100, flight.autoCashoutX100);
      if (planned.kind === 'WIN') win = { x100: planned.atX100, reason: planned.reason };
      else bust = true;
    } else if (request === 'PLAYER') {
      // Before settleAt the balloon is still up and below every target, so the current multiplier is safe to pay.
      const x100 = multiplierAt(now.getTime() - flight.startedAt.getTime());
      if (x100 < 101) {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.CASHOUT_TOO_EARLY, 'Cash-out opens at 1.01×');
      }
      win = { x100: Math.min(x100, flight.capX100), reason: 'PLAYER' };
    } else {
      return flight;
    }

    if (bust) {
      return tx.flight.update({
        where: { id: flight.id },
        data: { status: FlightStatus.BUSTED, settledAt: now },
        include: flightInclude,
      });
    }
    const w = win!;
    const payout = payoutFor(flight.betMinor, w.x100);
    if (payout > flight.maxPayoutMinor) throw new Error(`Flight ${flight.id} would pay more than its cap`);
    const reserve = await this.ledger.system(tx, AccountType.GAME_RESERVE);
    const wallet = await this.ledger.wallet(tx, flight.userId);
    const posted = await this.ledger.transfer(tx, reserve, wallet, payout, {
      type: JournalType.PAYOUT,
      idempotencyKey: `payout:${flight.id}`,
      description: `Updraft win at ${formatX100(w.x100)}×`,
      metadata: { flightId: flight.id, cashoutX100: w.x100, reason: w.reason },
    });
    return tx.flight.update({
      where: { id: flight.id },
      data: {
        status: FlightStatus.CASHED_OUT,
        cashoutX100: w.x100,
        cashoutReason: w.reason,
        payoutMinor: payout,
        payoutJournalId: posted.journal.id,
        settledAt: now,
      },
      include: flightInclude,
    });
  }

  private async lockFlight(tx: Tx, id: string, userId: string): Promise<FlightWithSeed | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM flights WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.flight.findUniqueOrThrow({ where: { id }, include: flightInclude });
  }

  private async lockOpenFlightOf(tx: Tx, userId: string): Promise<FlightWithSeed | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM flights WHERE user_id = ${userId}::uuid AND status = 'OPEN' FOR UPDATE`;
    if (!rows.length) return null;
    return tx.flight.findUniqueOrThrow({ where: { id: rows[0].id }, include: flightInclude });
  }

  private async activePair(tx: Tx, userId: string, lock: boolean): Promise<SeedPair> {
    const rows = lock
      ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM seed_pairs WHERE user_id = ${userId}::uuid AND active FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM seed_pairs WHERE user_id = ${userId}::uuid AND active`;
    if (rows.length) return tx.seedPair.findUniqueOrThrow({ where: { id: rows[0].id } });
    return this.createPair(tx, userId);
  }

  private async createPair(tx: Tx, userId: string, clientSeed?: string): Promise<SeedPair> {
    const serverSeed = newServerSeed();
    await tx.$executeRaw`
      INSERT INTO seed_pairs (id, user_id, server_seed, server_seed_hash, client_seed)
      VALUES (gen_random_uuid(), ${userId}::uuid, ${serverSeed}, ${hashSeed(serverSeed)}, ${clientSeed ?? newClientSeed()})
      ON CONFLICT DO NOTHING`;
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM seed_pairs WHERE user_id = ${userId}::uuid AND active FOR UPDATE`;
    return tx.seedPair.findUniqueOrThrow({ where: { id: rows[0].id } });
  }

  private async now(tx: Tx): Promise<Date> {
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return now;
  }

  toDto(f: FlightWithSeed, now: Date): FlightDto {
    const units = this.config.currency.minorUnits;
    const money = (v: bigint) => formatMinor(v, units);
    const open = f.status === FlightStatus.OPEN;
    return {
      id: f.id,
      status: f.status,
      currency: this.config.currency.code,
      betMinor: f.betMinor.toString(),
      bet: money(f.betMinor),
      autoCashoutX100: f.autoCashoutX100,
      capX100: f.capX100,
      cap: formatX100(f.capX100),
      maxPayoutMinor: f.maxPayoutMinor.toString(),
      startedAt: f.startedAt.toISOString(),
      serverTime: now.toISOString(),
      multiplierX100: open ? multiplierAt(now.getTime() - f.startedAt.getTime()) : null,
      cashoutX100: f.cashoutX100,
      cashoutReason: f.cashoutReason,
      payoutMinor: f.payoutMinor?.toString() ?? null,
      payout: f.payoutMinor === null ? null : money(f.payoutMinor),
      profitMinor: open ? null : ((f.payoutMinor ?? 0n) - f.betMinor).toString(),
      crashX100: open ? null : f.crashX100.toString(),
      crash: open ? null : formatX100(f.crashX100),
      settledAt: f.settledAt?.toISOString() ?? null,
      fairness: {
        serverSeedHash: f.seedPair.serverSeedHash,
        clientSeed: f.seedPair.clientSeed,
        nonce: f.nonce,
        edgeBps: f.edgeBps,
        serverSeed: f.seedPair.revealedAt ? f.seedPair.serverSeed : null,
      },
    };
  }
}
