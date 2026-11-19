import { createHmac } from 'node:crypto';
import { crashPointX100 } from '../src/game/fairness';
import { msToReach, plannedOutcome } from '../src/game/flight-math';
import { age, auth, balance, createApp, credit, fundReserve, key, player, reconcile, resetDb, staff } from './helpers';
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

/** Gives an open flight a chosen pop point, keeping its other rules, so a test can decide the outcome. */
async function forceCrash(flightId: string, crashX100: bigint) {
  const f = await t.prisma.flight.findUniqueOrThrow({ where: { id: flightId } });
  const planned = plannedOutcome(crashX100, f.capX100, f.autoCashoutX100);
  await t.prisma.flight.update({
    where: { id: flightId },
    data: { crashX100, settleAt: new Date(f.startedAt.getTime() + planned.afterMs) },
  });
}

async function start(token: string, betMinor: string, extra: Record<string, unknown> = {}, k = key()) {
  return t.http().post('/api/v1/game/flights').set(auth(token)).set('Idempotency-Key', k).send({ betMinor, ...extra });
}

describe('a flight', () => {
  it('takes the bet, hides the pop point while flying, and pays a manual cash-out', async () => {
    const p = await player(t);
    await credit(t, p.id, 10_000n);
    const res = await start(p.token, '5000');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.crashX100).toBeNull();
    expect(res.body.fairness.serverSeed).toBeNull();
    expect(await balance(t, p.token)).toBe(5_000n);

    await forceCrash(res.body.id, 500n);
    await age(t, res.body.id, msToReach(200) + 50);
    const out = await t.http().post(`/api/v1/game/flights/${res.body.id}/cash-out`).set(auth(p.token)).expect(200);
    expect(out.body.status).toBe('CASHED_OUT');
    expect(out.body.cashoutReason).toBe('PLAYER');
    expect(out.body.cashoutX100).toBeGreaterThanOrEqual(200);
    expect(out.body.cashoutX100).toBeLessThan(210);
    expect(out.body.crashX100).toBe('500');
    expect(await balance(t, p.token)).toBe(5_000n + (5_000n * BigInt(out.body.cashoutX100)) / 100n);
    expect((await reconcile(t, finance.token)).ok).toBe(true);
  });

  it('loses the bet when cash-out comes after the pop', async () => {
    const p = await player(t);
    await credit(t, p.id, 10_000n);
    const res = await start(p.token, '5000');
    await forceCrash(res.body.id, 150n);
    await age(t, res.body.id, msToReach(160));
    const out = await t.http().post(`/api/v1/game/flights/${res.body.id}/cash-out`).set(auth(p.token)).expect(200);
    expect(out.body.status).toBe('BUSTED');
    expect(out.body.payoutMinor).toBeNull();
    expect(await balance(t, p.token)).toBe(5_000n);
  });

  it('refuses a cash-out before 1.01×', async () => {
    const p = await player(t);
    await credit(t, p.id, 10_000n);
    const res = await start(p.token, '5000');
    await forceCrash(res.body.id, 500n);
    const out = await t.http().post(`/api/v1/game/flights/${res.body.id}/cash-out`).set(auth(p.token));
    expect(out.status).toBe(409);
    expect(out.body.error).toBe('CASHOUT_TOO_EARLY');
  });

  it('pays an auto cash-out through the background job when the player is gone', async () => {
    const p = await player(t);
    await credit(t, p.id, 10_000n);
    const res = await start(p.token, '5000', { autoCashoutX100: 200 });
    await forceCrash(res.body.id, 300n);
    await age(t, res.body.id, msToReach(200));
    expect(await t.game.settleDue()).toBe(1);
    const f = await t.prisma.flight.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(f.status).toBe('CASHED_OUT');
    expect(f.cashoutReason).toBe('AUTO');
    expect(f.payoutMinor).toBe(10_000n);
    expect(await balance(t, p.token)).toBe(15_000n);
  });

  it('cashes out at the reserve limit even if the player wanted more', async () => {
    const p = await player(t);
    await credit(t, p.id, 100_000n);
    // Free reserve 10,000,000 → limit 100,000 per flight; a 100,000 bet is capped at 2.00×.
    const res = await start(p.token, '100000', { autoCashoutX100: 5000 });
    expect(res.body.capX100).toBe(200);
    await forceCrash(res.body.id, 10_000n);
    await age(t, res.body.id, msToReach(200));
    await t.game.settleDue();
    const f = await t.prisma.flight.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(f).toMatchObject({ status: 'CASHED_OUT', cashoutReason: 'LIMIT', cashoutX100: 200, payoutMinor: 200_000n });
  });

  it('cannot be settled twice when the player and the job race', async () => {
    const p = await player(t);
    await credit(t, p.id, 10_000n);
    const res = await start(p.token, '5000', { autoCashoutX100: 150 });
    await forceCrash(res.body.id, 300n);
    await age(t, res.body.id, msToReach(150) + 10);
    const [a, b, c] = await Promise.all([
      t.http().post(`/api/v1/game/flights/${res.body.id}/cash-out`).set(auth(p.token)),
      t.game.settleDue(),
      t.http().get(`/api/v1/game/flights/${res.body.id}`).set(auth(p.token)),
    ]);
    expect([200, 409]).toContain(a.status);
    expect(c.status).toBe(200);
    expect(b).toBeLessThanOrEqual(1);
    const payouts = await t.prisma.journal.count({ where: { type: 'PAYOUT' } });
    expect(payouts).toBe(1);
    expect(await balance(t, p.token)).toBe(5_000n + 7_500n);
    expect((await reconcile(t, finance.token)).ok).toBe(true);
  });

  it('replays a retried start instead of betting twice', async () => {
    const p = await player(t);
    await credit(t, p.id, 10_000n);
    const k = key();
    const [a, b] = await Promise.all([start(p.token, '3000', {}, k), start(p.token, '3000', {}, k)]);
    expect(a.body.id).toBe(b.body.id);
    expect(await balance(t, p.token)).toBe(7_000n);
    const reused = await start(p.token, '4000', {}, k);
    expect(reused.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('allows one flight at a time and refuses bets the wallet cannot cover', async () => {
    const p = await player(t);
    await credit(t, p.id, 10_000n);
    const first = await start(p.token, '3000');
    await forceCrash(first.body.id, 1_000_000n);
    const second = await start(p.token, '3000');
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('FLIGHT_IN_PROGRESS');

    const q = await player(t);
    await credit(t, q.id, 1_000n);
    const broke = await start(q.token, '5000');
    expect(broke.body.error).toBe('INSUFFICIENT_FUNDS');
    expect(await balance(t, q.token)).toBe(1_000n);
    expect(await t.prisma.flight.count({ where: { userId: q.id } })).toBe(0);
  });

  it('refuses staff and bets outside the limits', async () => {
    const s = await start(finance.token, '5000');
    expect(s.status).toBe(403);
    const p = await player(t);
    await credit(t, p.id, 1_000_000n);
    expect((await start(p.token, '50')).body.error).toBe('BET_TOO_SMALL');
    const big = await start(p.token, '100001');
    expect(big.body.error).toBe('BET_ABOVE_LIMIT');
    expect(big.body.details.maxBetMinor).toBe('100000');
  });

  it('is closed when the game is switched off', async () => {
    const off = await createApp({ GAME_ENABLED: 'false' });
    try {
      const p = await player(off);
      const res = await off.http().post('/api/v1/game/flights').set(auth(p.token)).set('Idempotency-Key', key()).send({ betMinor: '500' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('GAME_DISABLED');
    } finally {
      await off.close();
    }
  });
});

describe('the reserve', () => {
  it('cannot be overcommitted by many players betting at once', async () => {
    // Reserve 1,000,000 → total risk 10% = 100,000; per flight 1% of free.
    await resetDb(t.prisma);
    finance = await staff(t, 'FINANCE');
    await fundReserve(t, finance.token, 1_000_000n);
    const players = await Promise.all(Array.from({ length: 30 }, () => player(t)));
    await Promise.all(players.map((p) => credit(t, p.id, 100_000n)));
    const results = await Promise.all(players.map((p) => start(p.token, '10000')));
    const accepted = results.filter((r) => r.status === 201);
    expect(accepted.length).toBeGreaterThan(0);
    const [row] = await t.prisma.$queryRaw<{ risk: bigint; committed: bigint }[]>`
      SELECT COALESCE(SUM(max_payout_minor - bet_minor),0)::bigint AS risk, COALESCE(SUM(max_payout_minor),0)::bigint AS committed FROM flights WHERE status = 'OPEN'`;
    const reserve = await t.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'GAME_RESERVE' } });
    expect(row.committed).toBeLessThanOrEqual(reserve.balanceMinor);
    expect(row.risk).toBeLessThanOrEqual(110_000n);

    // Every open flight wins its maximum: the reserve must still pay all of them.
    const open = await t.prisma.flight.findMany({ where: { status: 'OPEN' } });
    for (const f of open) {
      await forceCrash(f.id, 1_000_000n);
      await age(t, f.id, msToReach(f.capX100) + 10);
    }
    await t.game.settleDue(1000);
    expect(await t.prisma.flight.count({ where: { status: 'OPEN' } })).toBe(0);
    const after = await t.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'GAME_RESERVE' } });
    expect(after.balanceMinor).toBeGreaterThanOrEqual(0n);
    expect((await reconcile(t, finance.token)).ok).toBe(true);
  });

  it('cannot be withdrawn below what open flights could win', async () => {
    const p = await player(t);
    await credit(t, p.id, 100_000n);
    const res = await start(p.token, '100000');
    await forceCrash(res.body.id, 1_000_000n);
    const reserve = await t.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'GAME_RESERVE' } });
    const tooMuch = await t
      .http()
      .post('/api/v1/admin/reserve/withdraw')
      .set(auth(finance.token))
      .set('Idempotency-Key', key())
      .send({ amountMinor: reserve.balanceMinor.toString(), reason: 'Take everything' });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toBe('RESERVE_TOO_LOW');
    expect(tooMuch.body.details.freeMinor).toBe((reserve.balanceMinor - 200_000n).toString());

    const ok = await t
      .http()
      .post('/api/v1/admin/reserve/withdraw')
      .set(auth(finance.token))
      .set('Idempotency-Key', key())
      .send({ amountMinor: '1000000', reason: 'Monthly profit' });
    expect(ok.status).toBe(201);
    const audit = await t.prisma.auditLog.findMany({ where: { action: 'reserve.withdraw' } });
    expect(audit).toHaveLength(1);
  });

  it('is reported in the summary and only to staff', async () => {
    const p = await player(t);
    expect((await t.http().get('/api/v1/admin/summary').set(auth(p.token))).status).toBe(403);
    const res = await t.http().get('/api/v1/admin/summary').set(auth(finance.token)).expect(200);
    expect(res.body.reserve.balanceMinor).toBe('10000000');
    expect(res.body.reserve.maxBetNowMinor).toBe('100000');
    expect(res.body.results.allTime.flights).toBe(0);
  });
});

describe('fairness', () => {
  it('commits to the seed before the bet and reveals it on rotation, matching every flight', async () => {
    const p = await player(t);
    await credit(t, p.id, 100_000n);
    const seeds = await t.http().get('/api/v1/game/seeds').set(auth(p.token)).expect(200);
    const flights: { id: string; nonce: number; crash: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await start(p.token, '1000');
      expect(res.body.fairness.serverSeedHash).toBe(seeds.body.serverSeedHash);
      await age(t, res.body.id, 10 * 60_000);
      const done = await t.http().get(`/api/v1/game/flights/${res.body.id}`).set(auth(p.token)).expect(200);
      expect(done.body.status).not.toBe('OPEN');
      flights.push({ id: done.body.id, nonce: done.body.fairness.nonce, crash: done.body.crashX100 });
    }
    const rotated = await t.http().post('/api/v1/game/seeds/rotate').set(auth(p.token)).send({ clientSeed: 'my-own-seed' }).expect(200);
    const { serverSeed, serverSeedHash, clientSeed } = rotated.body.previous;
    expect(serverSeedHash).toBe(seeds.body.serverSeedHash);
    expect(rotated.body.current.clientSeed).toBe('my-own-seed');
    for (const f of flights) {
      expect(crashPointX100(serverSeed, clientSeed, f.nonce, 300).toString()).toBe(f.crash);
      // Independent re-implementation of the published formula.
      const h = BigInt('0x' + createHmac('sha256', serverSeed).update(`${clientSeed}:${f.nonce}`).digest('hex').slice(0, 13));
      const e = 2n ** 52n;
      const c = (9700n * e) / (100n * (e - h));
      expect((c < 100n ? 100n : c).toString()).toBe(f.crash);
    }
    const shown = await t.http().get(`/api/v1/game/flights/${flights[0].id}`).set(auth(p.token)).expect(200);
    expect(shown.body.fairness.serverSeed).toBe(serverSeed);
  });
});

describe('accounts', () => {
  it('rotates refresh tokens and ends the sign-in when an old one is reused', async () => {
    const reg = await t.http().post('/api/v1/auth/register').send({ phoneNumber: '0911000111', password: 'secret123' }).expect(201);
    expect(reg.body.user.phoneNumber).toBe('+251911000111');
    const dup = await t.http().post('/api/v1/auth/register').send({ phoneNumber: '+251 91 100 0111', password: 'secret123' });
    expect(dup.body.error).toBe('PHONE_ALREADY_REGISTERED');
    const r1 = await t.http().post('/api/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken }).expect(200);
    const reuse = await t.http().post('/api/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken });
    expect(reuse.status).toBe(401);
    const r2 = await t.http().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
    const bad = await t.http().post('/api/v1/auth/login').send({ phoneNumber: '0911000111', password: 'wrong-pass1' });
    expect(bad.body.error).toBe('INVALID_CREDENTIALS');
    await t.http().post('/api/v1/auth/login').send({ phoneNumber: '0911000111', password: 'secret123' }).expect(200);
  });

  it('rejects requests without a valid token', async () => {
    expect((await t.http().get('/api/v1/wallet')).status).toBe(401);
    expect((await t.http().get('/api/v1/wallet').set(auth('nonsense'))).status).toBe(401);
    expect((await t.http().get('/api/v1/game/info')).status).toBe(200);
  });
});
