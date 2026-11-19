import { createHmac, createHash } from 'node:crypto';
import { msToReach } from '../src/game/flight-math';
import { auth, balance, createApp, credit, fundReserve, key, player, reconcile, resetDb, staff } from './helpers';
import type { TestApp } from './helpers';

let t: TestApp;
let finance: { id: string; token: string };

beforeAll(async () => {
  t = await createApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.prisma);
  finance = await staff(t, 'FINANCE');
  await fundReserve(t, finance.token, 10_000_000n); // 100,000.00 ETB
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Opens a round (the engine does this on its own every tick in production). */
async function openRound() {
  await t.game.tick();
  return t.prisma.round.findFirstOrThrow({ where: { status: 'BETTING' } });
}

/** Gives the betting round a chosen pop point so a test can decide the outcome. */
async function forceCrash(roundId: string, crashX100: bigint) {
  await t.prisma.round.update({ where: { id: roundId }, data: { crashX100 } });
}

/** Moves lift-off `msAgo` milliseconds into the past and lets the engine run. */
async function liftOff(roundId: string, msAgo: number) {
  await t.prisma.$executeRaw`UPDATE rounds SET starts_at = clock_timestamp() - make_interval(secs => ${msAgo / 1000}) WHERE id = ${roundId}::uuid`;
  await t.game.tick();
}

/** Lets more time pass for a flying round and its bets. */
async function later(roundId: string, ms: number) {
  await t.prisma.$executeRaw`UPDATE rounds SET starts_at = starts_at - make_interval(secs => ${ms / 1000}) WHERE id = ${roundId}::uuid`;
  await t.prisma.$executeRaw`UPDATE bets SET settle_at = settle_at - make_interval(secs => ${ms / 1000}) WHERE round_id = ${roundId}::uuid`;
}

const bet = (token: string, betMinor: string, extra: Record<string, unknown> = {}, k = key()) =>
  t.http().post('/api/v1/game/bets').set(auth(token)).set('Idempotency-Key', k).send({ betMinor, ...extra });

const live = (token: string) => t.http().get('/api/v1/game/live').set(auth(token)).expect(200);

describe('a shared round', () => {
  it('runs from betting to lift-off to pop, with everyone seeing everyone', async () => {
    const a = await player(t);
    const b = await player(t);
    await credit(t, a.id, 10_000n);
    await credit(t, b.id, 10_000n);
    const round = await openRound();
    await forceCrash(round.id, 300n);

    expect((await bet(a.token, '5000')).status).toBe(201);
    expect((await bet(b.token, '4000', { autoCashoutX100: 150 })).status).toBe(201);
    expect(await balance(t, a.token)).toBe(5_000n);

    // Both players see the same round and each other, with numbers masked and no pop point.
    const seenByA = await live(a.token);
    expect(seenByA.body.round.status).toBe('BETTING');
    expect(seenByA.body.round.playerCount).toBe(2);
    expect(seenByA.body.round.crashX100).toBeNull();
    expect(seenByA.body.round.seed).toBeNull();
    expect(seenByA.body.round.players[0].player).toMatch(/^\+2519\*+\d\d$/);
    expect(seenByA.body.me.betMinor).toBe('5000');
    const seenByB = await live(b.token);
    expect(seenByB.body.round.id).toBe(seenByA.body.round.id);
    expect(seenByB.body.me.betMinor).toBe('4000');

    await liftOff(round.id, msToReach(200) + 30);
    const late = await player(t);
    await credit(t, late.id, 10_000n);
    expect((await bet(late.token, '1000')).body.error).toBe('BETTING_CLOSED');

    // B's auto cash-out at 1.50× was due before 2.00×: the engine pays it.
    await t.game.tick();
    const aBet = (await live(a.token)).body.me;
    const out = await t.http().post(`/api/v1/game/bets/${aBet.id}/cash-out`).set(auth(a.token)).expect(200);
    expect(out.body.status).toBe('CASHED_OUT');
    expect(out.body.cashoutX100).toBeGreaterThanOrEqual(200);
    expect(out.body.cashoutX100).toBeLessThan(215);

    const mid = await live(b.token);
    expect(mid.body.round.status).toBe('FLYING');
    const bRow = mid.body.round.players.find((p: { betMinor: string }) => p.betMinor === '4000');
    expect(bRow).toMatchObject({ status: 'CASHED_OUT', cashoutX100: 150, payoutMinor: '6000' });

    // Past the pop: the round ends, reveals its seed, and the next round opens.
    await later(round.id, msToReach(300));
    await t.game.tick();
    await t.game.tick();
    const ended = await t.prisma.round.findUniqueOrThrow({ where: { id: round.id } });
    expect(ended.status).toBe('ENDED');
    expect(await t.prisma.round.count({ where: { status: 'BETTING' } })).toBe(1);

    const rounds = await t.http().get('/api/v1/game/rounds').expect(200);
    const r = rounds.body.items[0];
    expect(r.number).toBe(round.number);
    expect(r.crashX100).toBe('300');
    expect(await balance(t, b.token)).toBe(6_000n + 6_000n);
    expect((await reconcile(t, finance.token)).ok).toBe(true);
  });

  it('loses bets still flying when it pops', async () => {
    const p = await player(t);
    await credit(t, p.id, 10_000n);
    const round = await openRound();
    await forceCrash(round.id, 150n);
    await bet(p.token, '5000');
    await liftOff(round.id, msToReach(160));
    const me = (await live(p.token)).body.me;
    const out = await t.http().post(`/api/v1/game/bets/${me.id}/cash-out`).set(auth(p.token)).expect(200);
    expect(out.body.status).toBe('BUSTED');
    expect(await balance(t, p.token)).toBe(5_000n);
  });

  it('refuses cash-outs before lift-off and before 1.01×', async () => {
    const p = await player(t);
    await credit(t, p.id, 10_000n);
    const round = await openRound();
    await forceCrash(round.id, 500n);
    const placed = await bet(p.token, '5000');
    const before = await t.http().post(`/api/v1/game/bets/${placed.body.id}/cash-out`).set(auth(p.token));
    expect(before.body.error).toBe('NOT_STARTED');
    await liftOff(round.id, 0);
    const early = await t.http().post(`/api/v1/game/bets/${placed.body.id}/cash-out`).set(auth(p.token));
    expect(early.body.error).toBe('CASHOUT_TOO_EARLY');
  });

  it('takes one bet per player per round, replays retries and refuses what the wallet cannot cover', async () => {
    const p = await player(t);
    await credit(t, p.id, 10_000n);
    await openRound();
    const k = key();
    const [x, y] = await Promise.all([bet(p.token, '3000', {}, k), bet(p.token, '3000', {}, k)]);
    expect(x.body.id).toBe(y.body.id);
    expect((await bet(p.token, '3000')).body.error).toBe('ALREADY_IN_ROUND');
    expect(await balance(t, p.token)).toBe(7_000n);

    const q = await player(t);
    await credit(t, q.id, 1_000n);
    expect((await bet(q.token, '5000')).body.error).toBe('INSUFFICIENT_FUNDS');
    expect(await t.prisma.bet.count({ where: { userId: q.id } })).toBe(0);
  });

  it('refuses staff and bets outside the limits', async () => {
    await openRound();
    expect((await bet(finance.token, '5000')).status).toBe(403);
    const p = await player(t);
    await credit(t, p.id, 1_000_000n);
    expect((await bet(p.token, '50')).body.error).toBe('BET_TOO_SMALL');
    const big = await bet(p.token, '100001');
    expect(big.body.error).toBe('BET_ABOVE_LIMIT');
    expect(big.body.details.maxBetMinor).toBe('100000');
  });

  it('opens exactly one round when several engines tick at once', async () => {
    await Promise.all([t.game.tick(), t.game.tick(), t.game.tick(), t.game.tick()]);
    expect(await t.prisma.round.count()).toBe(1);
  });
});

describe('the shared reserve limit', () => {
  it('lets 30 players bet 1,000 at once and cashes them out together within the reserve', async () => {
    const players = await Promise.all(Array.from({ length: 30 }, () => player(t)));
    await Promise.all(players.map((p) => credit(t, p.id, 100_000n)));
    const round = await openRound();
    await forceCrash(round.id, 1_000_000n);
    const results = await Promise.all(players.map((p) => bet(p.token, '100000')));
    expect(results.every((r) => r.status === 201)).toBe(true);

    // 10% of 100,000 = 10,000 of room; 30,000 bet → everyone is cashed out at 1.33×.
    const r = await t.prisma.round.findUniqueOrThrow({ where: { id: round.id } });
    expect(r.capX100).toBe(133);
    const seen = await live(players[0].token);
    expect(seen.body.round.capX100).toBe(133);
    expect(seen.body.round.playerCount).toBe(30);

    const reserve = await t.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'GAME_RESERVE' } });
    const [owed] = await t.prisma.$queryRaw<{ total: bigint }[]>`SELECT SUM(max_payout_minor)::bigint AS total FROM bets WHERE status = 'OPEN'`;
    expect(owed.total).toBeLessThanOrEqual(reserve.balanceMinor);

    await liftOff(round.id, msToReach(133) + 20);
    await t.game.tick();
    const bets = await t.prisma.bet.findMany({ where: { roundId: round.id } });
    expect(bets.every((b) => b.status === 'CASHED_OUT' && b.cashoutReason === 'LIMIT' && b.cashoutX100 === 133)).toBe(true);
    const after = await t.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'GAME_RESERVE' } });
    expect(after.balanceMinor).toBe(10_000_000n - 30n * 33_000n);
    expect((await reconcile(t, finance.token)).ok).toBe(true);
  });

  it('cannot be withdrawn below what open bets could win', async () => {
    const p = await player(t);
    await credit(t, p.id, 100_000n);
    const round = await openRound();
    await forceCrash(round.id, 1_000_000n);
    await bet(p.token, '100000');
    const reserve = await t.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'GAME_RESERVE' } });
    const tooMuch = await t
      .http()
      .post('/api/v1/admin/reserve/withdraw')
      .set(auth(finance.token))
      .set('Idempotency-Key', key())
      .send({ amountMinor: reserve.balanceMinor.toString(), reason: 'Take everything' });
    expect(tooMuch.body.error).toBe('RESERVE_TOO_LOW');
    expect(tooMuch.body.details.freeMinor).toBe((reserve.balanceMinor - 200_000n).toString());
    const ok = await t
      .http()
      .post('/api/v1/admin/reserve/withdraw')
      .set(auth(finance.token))
      .set('Idempotency-Key', key())
      .send({ amountMinor: '1000000', reason: 'Monthly profit' });
    expect(ok.status).toBe(201);
  });

  it('is reported in the summary and only to staff', async () => {
    const p = await player(t);
    expect((await t.http().get('/api/v1/admin/summary').set(auth(p.token))).status).toBe(403);
    await openRound();
    const res = await t.http().get('/api/v1/admin/summary').set(auth(finance.token)).expect(200);
    expect(res.body.reserve.balanceMinor).toBe('10000000');
    expect(res.body.reserve.maxBetNowMinor).toBe('100000');
    expect(res.body.currentRound.status).toBe('BETTING');
  });
});

describe('fairness', () => {
  it('reveals seeds that hash back to the published commitment and give each pop point', async () => {
    const chain = async () => (await t.http().get('/api/v1/game/chains').expect(200)).body.items[0];
    await openRound();
    const { commitment, salt } = await chain();
    // Play three rounds through without bets.
    for (let i = 0; i < 3; i++) {
      const r = await t.prisma.round.findFirstOrThrow({ where: { status: { not: 'ENDED' } } });
      await liftOff(r.id, 10 * 60_000);
      await t.game.tick();
    }
    const items = (await t.http().get('/api/v1/game/rounds').expect(200)).body.items.reverse();
    expect(items).toHaveLength(3);
    let previous = commitment;
    for (const r of items) {
      expect(sha(r.seed)).toBe(previous);
      const h = BigInt('0x' + createHmac('sha256', r.seed).update(salt).digest('hex').slice(0, 13));
      const e = 2n ** 52n;
      const c = (9700n * e) / (100n * (e - h));
      expect((c < 100n ? 100n : c).toString()).toBe(r.crashX100);
      previous = r.seed;
    }
    // The open round's seed is not public yet.
    const current = await live((await player(t)).token);
    expect(current.body.round.seed).toBeNull();
  });
});

describe('when switched off', () => {
  it('opens no rounds and takes no bets', async () => {
    const off = await createApp({ GAME_ENABLED: 'false' });
    try {
      await resetDb(off.prisma);
      await off.game.tick();
      expect(await off.prisma.round.count()).toBe(0);
      const p = await player(off);
      const res = await off.http().post('/api/v1/game/bets').set(auth(p.token)).set('Idempotency-Key', key()).send({ betMinor: '500' });
      expect(res.body.error).toBe('GAME_DISABLED');
    } finally {
      await off.close();
    }
  });
});

describe('accounts', () => {
  it('rotates refresh tokens and ends the sign-in when an old one is reused', async () => {
    const reg = await t.http().post('/api/v1/auth/register').send({ phoneNumber: '0911000111', password: 'secret123' }).expect(201);
    expect(reg.body.user.phoneNumber).toBe('+251911000111');
    const dup = await t.http().post('/api/v1/auth/register').send({ phoneNumber: '+251 91 100 0111', password: 'secret123' });
    expect(dup.body.error).toBe('PHONE_ALREADY_REGISTERED');
    const r1 = await t.http().post('/api/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken }).expect(200);
    expect((await t.http().post('/api/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken })).status).toBe(401);
    expect((await t.http().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken })).status).toBe(401);
    const bad = await t.http().post('/api/v1/auth/login').send({ phoneNumber: '0911000111', password: 'wrong-pass1' });
    expect(bad.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('rejects requests without a valid token', async () => {
    expect((await t.http().get('/api/v1/game/live')).status).toBe(401);
    expect((await t.http().get('/api/v1/wallet').set(auth('nonsense'))).status).toBe(401);
    expect((await t.http().get('/api/v1/game/info')).status).toBe(200);
  });
});
