import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AccountType, BetStatus, JournalType, RoundStatus } from '@prisma/client';
import type { Bet, Round, SeedChain } from '@prisma/client';
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
import { chainSeed, newTopSeed, roundCrashX100 } from './fairness';
import { GROWTH_PER_SECOND, msToReach, multiplierAt, payoutFor, plannedOutcome } from './flight-math';
import type { CashoutReason } from './flight-math';
import { capFor, currentLimits, roundCap } from './risk';
import type { ReserveState, RiskSettings } from './risk';

type BetWithRound = Bet & { round: Round };

export interface BetDto {
  id: string;
  roundId: string;
  roundNumber: number;
  status: BetStatus;
  betMinor: string;
  bet: string;
  autoCashoutX100: number | null;
  capX100: number;
  maxPayoutMinor: string;
  cashoutX100: number | null;
  cashoutReason: string | null;
  payoutMinor: string | null;
  payout: string | null;
  profitMinor: string | null;
  /** Shown once the round has ended. */
  crashX100: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface LivePlayer {
  player: string;
  betMinor: string;
  status: BetStatus;
  cashoutX100: number | null;
  payoutMinor: string | null;
}

export interface LiveRound {
  id: string;
  number: number;
  status: RoundStatus;
  startsAt: string;
  serverTime: string;
  /** Multiplier ×100 at serverTime while flying. */
  multiplierX100: number | null;
  /** Shared limit: everyone still flying is cashed out here. */
  capX100: number | null;
  crashX100: string | null;
  seed: string | null;
  endedAt: string | null;
  players: LivePlayer[];
  playerCount: number;
  totalBetMinor: string;
}

/** Shows a player to others without revealing the number: +2519******67. */
export const maskPhone = (e164: string) => `${e164.slice(0, 5)}${'*'.repeat(Math.max(0, e164.length - 7))}${e164.slice(-2)}`;

const ENGINE_LOCK = 7_001_001;
const LIVE_CACHE_MS = 150;

@Injectable()
export class GameService {
  private readonly logger = new Logger('Rounds');
  private readonly risk: RiskSettings;
  private liveCache: { at: number; value: { round: LiveRound | null; history: { number: number; crashX100: string; endedAt: string | null }[] } } | null = null;

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

  private money = (v: bigint) => formatMinor(v, this.config.currency.minorUnits);

  /** Public rules and today's bet limit. */
  async info() {
    const state = await this.prisma.$transaction((tx) => this.reserveState(tx));
    const limits = currentLimits({ ...state, openRiskMinor: 0n }, this.risk);
    return {
      enabled: this.config.game.enabled,
      currency: this.config.currency.code,
      minorUnits: this.config.currency.minorUnits,
      edgeBps: this.config.game.edgeBps,
      minBetMinor: this.risk.minBetMinor.toString(),
      minBet: this.money(this.risk.minBetMinor),
      maxBetMinor: limits.maxBetMinor.toString(),
      maxBet: this.money(limits.maxBetMinor),
      maxMultiplierX100: this.risk.maxMultiplierX100,
      flightRiskBps: this.risk.flightRiskBps,
      totalRiskBps: this.risk.totalRiskBps,
      bettingMs: this.config.game.bettingMs,
      growthPerSecond: GROWTH_PER_SECOND,
      serverTime: new Date().toISOString(),
    };
  }

  // ───────────────────────────── Betting ─────────────────────────────

  /**
   * Places a bet in the round that is taking bets, as one transaction. Every bet in a round shares the round's
   * reserve limit: when the round's possible winnings would pass the total limit, the shared cap comes down and
   * everyone still flying is cashed out together there.
   */
  async placeBet(user: AuthUser, betMinor: bigint, autoX100: number | null, key: string): Promise<{ bet: BetDto; replayed: boolean }> {
    if (!this.config.game.enabled) {
      throw new AppException(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.GAME_DISABLED, 'The game is closed right now');
    }
    if (isStaff(user.role)) throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, 'Staff accounts cannot play');
    if (autoX100 !== null && (autoX100 < 101 || autoX100 > this.risk.maxMultiplierX100)) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'Auto cash-out must be between 1.01× and the maximum multiplier');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`bet:${user.id}:${key}`}, 0))::text`;
      const earlier = await tx.bet.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: key } }, include: { round: true } });
      if (earlier) {
        if (earlier.betMinor !== betMinor || earlier.autoCashoutX100 !== autoX100) {
          throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.IDEMPOTENCY_KEY_REUSED, 'This idempotency key was already used for a different bet');
        }
        return { bet: this.toDto(earlier), replayed: true };
      }

      // Every new commitment of the reserve takes this lock, so limits are checked against a settled picture.
      await tx.$queryRaw`SELECT id FROM game_state WHERE id = 1 FOR UPDATE`;
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM rounds WHERE status = 'BETTING' FOR UPDATE`;
      const now = await this.now(tx);
      const round = locked.length ? await tx.round.findUniqueOrThrow({ where: { id: locked[0].id } }) : null;
      if (!round || now >= round.startsAt) {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.BETTING_CLOSED, 'Betting for this round has closed. The next round opens in a moment.');
      }
      if (await tx.bet.count({ where: { roundId: round.id, userId: user.id } })) {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.ALREADY_IN_ROUND, 'You already have a bet in this round');
      }

      const wallet = await this.ledger.wallet(tx, user.id);
      const reserve = await this.ledger.system(tx, AccountType.GAME_RESERVE);
      // Same order as the ledger (by id), so this cannot deadlock with a payout.
      await tx.$queryRaw`SELECT id FROM ledger_accounts WHERE id = ANY(${[wallet.id, reserve.id]}::uuid[]) ORDER BY id FOR UPDATE`;

      const state = await this.reserveState(tx);
      // Per bet: 1% of the base. The total for all open bets is enforced by the round's shared cap below.
      const limits = currentLimits({ ...state, openRiskMinor: 0n }, this.risk);
      if (betMinor < this.risk.minBetMinor) {
        throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.BET_TOO_SMALL, `The smallest bet is ${this.money(this.risk.minBetMinor)}`, {
          minBetMinor: this.risk.minBetMinor.toString(),
        });
      }
      if (betMinor > limits.maxBetMinor) {
        throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.BET_ABOVE_LIMIT, `The largest bet right now is ${this.money(limits.maxBetMinor)}`, {
          maxBetMinor: limits.maxBetMinor.toString(),
        });
      }
      const personalCapX100 = capFor(betMinor, limits.flightLimitMinor, this.risk.maxMultiplierX100);

      // Room for this round: the total limit, minus whatever bets of other rounds could still cost (normally none).
      const [other] = await tx.$queryRaw<{ risk: bigint }[]>`
        SELECT COALESCE(SUM(max_payout_minor - bet_minor), 0)::bigint AS risk FROM bets WHERE status = 'OPEN' AND round_id <> ${round.id}::uuid`;
      const base = state.reserveMinor - state.openBetsMinor;
      const room = (base * BigInt(this.risk.totalRiskBps)) / 10000n - other.risk;
      const inRound = await tx.bet.findMany({ where: { roundId: round.id }, select: { betMinor: true, personalCapX100: true } });
      const cap = roundCap([...inRound, { betMinor, personalCapX100 }], room, this.risk.maxMultiplierX100);
      if (cap === 'FULL') {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.ROUND_FULL, 'This round is full. Try the next one.');
      }

      const posted = await this.ledger.transfer(tx, wallet, reserve, betMinor, {
        type: JournalType.BET,
        idempotencyKey: `bet:${createHash('sha256').update(`${user.id}|${key}`).digest('hex')}`,
        description: `Updraft bet, round ${round.number}`,
        createdById: user.id,
        metadata: { roundId: round.id },
      });
      const capX100 = cap === null ? personalCapX100 : Math.min(cap, personalCapX100);
      const created = await tx.bet.create({
        data: {
          roundId: round.id,
          userId: user.id,
          idempotencyKey: key,
          betMinor,
          autoCashoutX100: autoX100,
          personalCapX100,
          capX100,
          maxPayoutMinor: payoutFor(betMinor, capX100),
          betJournalId: posted.journal.id,
        },
      });
      if (cap !== round.capX100) {
        await tx.round.update({ where: { id: round.id }, data: { capX100: cap } });
        await tx.$executeRaw`
          UPDATE bets SET cap_x100 = LEAST(personal_cap_x100, ${cap ?? this.risk.maxMultiplierX100}),
                          max_payout_minor = bet_minor * LEAST(personal_cap_x100, ${cap ?? this.risk.maxMultiplierX100}) / 100
          WHERE round_id = ${round.id}::uuid AND status = 'OPEN'`;
      }

      // Last line of defence: the reserve must hold every open bet's largest payout.
      const after = await this.reserveState(tx);
      if (after.reserveMinor < after.committedMinor) throw new Error('Reserve would not cover open bets');

      const bet = await tx.bet.findUniqueOrThrow({ where: { id: created.id }, include: { round: true } });
      this.liveCache = null;
      return { bet: this.toDto(bet), replayed: false };
    }, MONEY_TX);
  }

  /** Cashes out at the multiplier the server clock shows now, if the balloon has not popped. */
  async cashOut(user: AuthUser, betId: string): Promise<BetDto> {
    return this.prisma.$transaction(async (tx) => {
      const bet = await this.lockBet(tx, betId, user.id);
      if (!bet) throw notFound('Bet not found');
      if (bet.status !== BetStatus.OPEN) {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.BET_SETTLED, 'This bet is already settled', { bet: this.toDto(bet) });
      }
      const settled = await this.settleLocked(tx, bet, 'PLAYER');
      this.liveCache = null;
      return this.toDto(settled);
    }, MONEY_TX);
  }

  async getBet(user: AuthUser, id: string): Promise<BetDto> {
    return this.prisma.$transaction(async (tx) => {
      const bet = await this.lockBet(tx, id, user.id);
      if (!bet) throw notFound('Bet not found');
      return this.toDto(bet.status === BetStatus.OPEN ? await this.settleLocked(tx, bet, null) : bet);
    }, MONEY_TX);
  }

  async listMine(userId: string, limit = 20) {
    const bets = await this.prisma.bet.findMany({
      where: { userId },
      include: { round: true },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return { items: bets.map((b) => this.toDto(b)) };
  }

  // ───────────────────────────── What everyone sees ─────────────────────────────

  /** The current round, everyone in it, recent pop points, and the caller's own bet. */
  async live(userId: string) {
    const shared = await this.sharedLive();
    let me: BetDto | null = null;
    if (shared.round) {
      const mine = await this.prisma.bet.findUnique({
        where: { roundId_userId: { roundId: shared.round.id, userId } },
        include: { round: true },
      });
      me = mine ? this.toDto(mine) : null;
    }
    const serverTime = new Date();
    const round = shared.round && {
      ...shared.round,
      serverTime: serverTime.toISOString(),
      multiplierX100:
        shared.round.status === RoundStatus.FLYING ? multiplierAt(serverTime.getTime() - Date.parse(shared.round.startsAt)) : null,
    };
    return { round, me, history: shared.history };
  }

  private async sharedLive() {
    if (this.liveCache && Date.now() - this.liveCache.at < LIVE_CACHE_MS) return this.liveCache.value;
    const round =
      (await this.prisma.round.findFirst({ where: { status: { not: RoundStatus.ENDED } } })) ??
      (await this.prisma.round.findFirst({ orderBy: { number: 'desc' } }));
    let live: LiveRound | null = null;
    if (round) {
      const bets = await this.prisma.bet.findMany({
        where: { roundId: round.id },
        include: { user: { select: { phoneNumber: true } } },
        orderBy: [{ betMinor: 'desc' }, { createdAt: 'asc' }],
      });
      const ended = round.status === RoundStatus.ENDED;
      live = {
        id: round.id,
        number: round.number,
        status: round.status,
        startsAt: round.startsAt.toISOString(),
        serverTime: '',
        multiplierX100: null,
        capX100: round.capX100,
        crashX100: ended ? round.crashX100.toString() : null,
        seed: ended ? round.seed : null,
        endedAt: round.endedAt?.toISOString() ?? null,
        playerCount: bets.length,
        totalBetMinor: bets.reduce((t, b) => t + b.betMinor, 0n).toString(),
        players: bets.slice(0, 100).map((b) => ({
          player: maskPhone(b.user.phoneNumber),
          betMinor: b.betMinor.toString(),
          status: b.status,
          cashoutX100: b.cashoutX100,
          payoutMinor: b.payoutMinor?.toString() ?? null,
        })),
      };
    }
    const history = (
      await this.prisma.round.findMany({ where: { status: RoundStatus.ENDED }, orderBy: { number: 'desc' }, take: 24 })
    ).map((r) => ({ number: r.number, crashX100: r.crashX100.toString(), endedAt: r.endedAt?.toISOString() ?? null }));
    const value = { round: live, history };
    this.liveCache = { at: Date.now(), value };
    return value;
  }

  /** Ended rounds with their seeds, for anyone to check. */
  async rounds(limit = 50, before?: number) {
    const rows = await this.prisma.round.findMany({
      where: { status: RoundStatus.ENDED, ...(before ? { number: { lt: before } } : {}) },
      include: { chain: { select: { commitment: true, salt: true } } },
      orderBy: { number: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return {
      items: rows.map((r) => ({
        number: r.number,
        seed: r.seed,
        chainIndex: r.chainIndex,
        chainCommitment: r.chain.commitment,
        salt: r.chain.salt,
        edgeBps: r.edgeBps,
        crashX100: r.crashX100.toString(),
        endedAt: r.endedAt?.toISOString() ?? null,
      })),
    };
  }

  async chains() {
    const rows = await this.prisma.seedChain.findMany({ orderBy: { createdAt: 'desc' } });
    return {
      items: rows.map((c) => ({
        commitment: c.commitment,
        salt: c.salt,
        length: c.length,
        roundsPlayed: c.nextIndex - 1,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  // ───────────────────────────── The round engine ─────────────────────────────

  /**
   * Moves the game forward: settles bets whose outcome is decided, lifts off a round when betting closes, ends it
   * once it has popped and everyone is settled, and opens the next. Safe to run on several servers at once: one
   * transaction-level lock picks who advances the rounds, and every bet is settled under its own row lock.
   */
  async tick(): Promise<void> {
    await this.settleDue();
    await this.prisma.$transaction(async (tx) => {
      const [{ ok }] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(${ENGINE_LOCK}) AS ok`;
      if (!ok) return;
      const now = await this.now(tx);
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM rounds WHERE status <> 'ENDED' FOR UPDATE`;
      if (!rows.length) {
        if (this.config.game.enabled) await this.openRound(tx, now);
        return;
      }
      let round = await tx.round.findUniqueOrThrow({ where: { id: rows[0].id } });

      if (round.status === RoundStatus.BETTING && now >= round.startsAt) {
        round = await tx.round.update({ where: { id: round.id }, data: { status: RoundStatus.FLYING } });
        // Caps are final now that betting is closed: fix when each bet is decided without its player.
        const bets = await tx.bet.findMany({ where: { roundId: round.id, status: BetStatus.OPEN } });
        for (const b of bets) {
          const plan = plannedOutcome(round.crashX100, b.capX100, b.autoCashoutX100);
          await tx.bet.update({ where: { id: b.id }, data: { settleAt: new Date(round.startsAt.getTime() + plan.afterMs) } });
        }
        this.liveCache = null;
      }

      if (round.status === RoundStatus.FLYING && now.getTime() >= round.startsAt.getTime() + msToReach(round.crashX100)) {
        const open = await tx.bet.count({ where: { roundId: round.id, status: BetStatus.OPEN } });
        if (open === 0) {
          await tx.round.update({ where: { id: round.id }, data: { status: RoundStatus.ENDED, endedAt: now } });
          this.liveCache = null;
          if (this.config.game.enabled) await this.openRound(tx, now);
        }
      }
    }, MONEY_TX);
  }

  /** Settles every open bet whose decision time has passed: auto cash-outs, limits and pops. */
  async settleDue(batch = 500): Promise<number> {
    const due = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM bets WHERE status = 'OPEN' AND settle_at <= clock_timestamp() ORDER BY settle_at LIMIT ${batch}`;
    let settled = 0;
    for (const { id } of due) {
      try {
        const done = await this.prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bets WHERE id = ${id}::uuid AND status = 'OPEN' FOR UPDATE SKIP LOCKED`;
          if (!rows.length) return false;
          const bet = await tx.bet.findUniqueOrThrow({ where: { id }, include: { round: true } });
          return (await this.settleLocked(tx, bet, null)).status !== BetStatus.OPEN;
        }, MONEY_TX);
        if (done) settled++;
      } catch (e) {
        this.logger.error(`Could not settle bet ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (settled) this.liveCache = null;
    return settled;
  }

  private async openRound(tx: Tx, now: Date): Promise<Round> {
    const chain = await this.activeChain(tx);
    const index = chain.nextIndex;
    await tx.seedChain.update({ where: { id: chain.id }, data: { nextIndex: index + 1 } });
    const seed = chainSeed(chain.topSeed, chain.length, index);
    const edgeBps = this.config.game.edgeBps;
    const [{ max }] = await tx.$queryRaw<{ max: number | null }[]>`SELECT MAX(number) AS max FROM rounds`;
    return tx.round.create({
      data: {
        number: (max ?? 0) + 1,
        chainId: chain.id,
        chainIndex: index,
        seed,
        edgeBps,
        crashX100: roundCrashX100(seed, chain.salt, edgeBps),
        startsAt: new Date(now.getTime() + this.config.game.bettingMs),
      },
    });
  }

  /** The chain in use, or a new one (with a new commitment) when none is left. */
  private async activeChain(tx: Tx): Promise<SeedChain> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM seed_chains WHERE next_index <= length ORDER BY created_at LIMIT 1 FOR UPDATE`;
    if (rows.length) return tx.seedChain.findUniqueOrThrow({ where: { id: rows[0].id } });
    const topSeed = newTopSeed();
    const length = this.config.game.chainLength;
    const chain = await tx.seedChain.create({
      data: { topSeed, length, commitment: chainSeed(topSeed, length, 0), salt: this.config.game.chainSalt },
    });
    this.logger.log(`New seed chain ${chain.commitment} (${length} rounds)`);
    return chain;
  }

  // ───────────────────────────── Settlement ─────────────────────────────

  /**
   * Decides a locked, open bet. `PLAYER` means the player asked to cash out now; null means only settle if the
   * outcome is already decided. Once that moment has passed the planned outcome applies, whatever the request.
   */
  private async settleLocked(tx: Tx, bet: BetWithRound, request: 'PLAYER' | null): Promise<BetWithRound> {
    if (bet.status !== BetStatus.OPEN) return bet;
    const round = bet.round;
    const now = await this.now(tx);
    if (now < round.startsAt) {
      if (request === 'PLAYER') throw new AppException(HttpStatus.CONFLICT, ErrorCode.NOT_STARTED, 'The balloon has not lifted off yet');
      return bet;
    }
    const plan = plannedOutcome(round.crashX100, bet.capX100, bet.autoCashoutX100);
    const decidedAt = round.startsAt.getTime() + plan.afterMs;
    let win: { x100: number; reason: CashoutReason } | null = null;

    if (now.getTime() >= decidedAt) {
      if (plan.kind === 'WIN') win = { x100: plan.atX100, reason: plan.reason };
    } else if (request === 'PLAYER') {
      // Before the decision moment the balloon is up and below every target, so the current multiplier is safe.
      const x100 = multiplierAt(now.getTime() - round.startsAt.getTime());
      if (x100 < 101) throw new AppException(HttpStatus.CONFLICT, ErrorCode.CASHOUT_TOO_EARLY, 'Cash-out opens at 1.01×');
      win = { x100: Math.min(x100, bet.capX100), reason: 'PLAYER' };
    } else {
      return bet;
    }

    if (!win) {
      return tx.bet.update({ where: { id: bet.id }, data: { status: BetStatus.BUSTED, settledAt: now }, include: { round: true } });
    }
    const payout = payoutFor(bet.betMinor, win.x100);
    if (payout > bet.maxPayoutMinor) throw new Error(`Bet ${bet.id} would pay more than its cap`);
    const reserve = await this.ledger.system(tx, AccountType.GAME_RESERVE);
    const wallet = await this.ledger.wallet(tx, bet.userId);
    const posted = await this.ledger.transfer(tx, reserve, wallet, payout, {
      type: JournalType.PAYOUT,
      idempotencyKey: `payout:${bet.id}`,
      description: `Updraft win at ${formatX100(win.x100)}×, round ${round.number}`,
      metadata: { betId: bet.id, roundId: round.id, cashoutX100: win.x100, reason: win.reason },
    });
    return tx.bet.update({
      where: { id: bet.id },
      data: {
        status: BetStatus.CASHED_OUT,
        cashoutX100: win.x100,
        cashoutReason: win.reason,
        payoutMinor: payout,
        payoutJournalId: posted.journal.id,
        settledAt: now,
      },
      include: { round: true },
    });
  }

  /** Reserve balance and what open bets could still take from it. Read under the caller's locks. */
  async reserveState(tx: Tx): Promise<ReserveState> {
    const reserve = await this.ledger.system(tx, AccountType.GAME_RESERVE);
    const [row] = await tx.$queryRaw<{ bets: bigint; committed: bigint; risk: bigint }[]>`
      SELECT COALESCE(SUM(bet_minor), 0)::bigint AS bets,
             COALESCE(SUM(max_payout_minor), 0)::bigint AS committed,
             COALESCE(SUM(max_payout_minor - bet_minor), 0)::bigint AS risk
      FROM bets WHERE status = 'OPEN'`;
    const fresh = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: reserve.id } });
    return { reserveMinor: fresh.balanceMinor, openBetsMinor: row.bets, committedMinor: row.committed, openRiskMinor: row.risk };
  }

  private async lockBet(tx: Tx, id: string, userId: string): Promise<BetWithRound | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bets WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.bet.findUniqueOrThrow({ where: { id }, include: { round: true } });
  }

  private async now(tx: Tx): Promise<Date> {
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return now;
  }

  toDto(b: BetWithRound): BetDto {
    const open = b.status === BetStatus.OPEN;
    const ended = b.round.status === RoundStatus.ENDED;
    return {
      id: b.id,
      roundId: b.roundId,
      roundNumber: b.round.number,
      status: b.status,
      betMinor: b.betMinor.toString(),
      bet: this.money(b.betMinor),
      autoCashoutX100: b.autoCashoutX100,
      capX100: b.capX100,
      maxPayoutMinor: b.maxPayoutMinor.toString(),
      cashoutX100: b.cashoutX100,
      cashoutReason: b.cashoutReason,
      payoutMinor: b.payoutMinor?.toString() ?? null,
      payout: b.payoutMinor === null ? null : this.money(b.payoutMinor),
      profitMinor: open ? null : ((b.payoutMinor ?? 0n) - b.betMinor).toString(),
      crashX100: ended ? b.round.crashX100.toString() : null,
      createdAt: b.createdAt.toISOString(),
      settledAt: b.settledAt?.toISOString() ?? null,
    };
  }
}

