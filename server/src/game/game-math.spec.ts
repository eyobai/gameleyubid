import { createHmac } from 'node:crypto';
import { crashPointX100, hashSeed } from './fairness';
import { msToReach, multiplierAt, payoutFor, plannedOutcome } from './flight-math';
import { capFor, checkBet, currentLimits } from './risk';
import type { RiskSettings } from './risk';

describe('crash points', () => {
  it('is deterministic for the same seeds and nonce', () => {
    expect(crashPointX100('a'.repeat(64), 'player', 7, 300)).toBe(crashPointX100('a'.repeat(64), 'player', 7, 300));
    expect(crashPointX100('a'.repeat(64), 'player', 7, 300)).not.toBe(crashPointX100('a'.repeat(64), 'player', 8, 300));
  });

  it('follows the published formula', () => {
    const seed = 'f'.repeat(64);
    const h = BigInt('0x' + createHmac('sha256', seed).update('abc:3').digest('hex').slice(0, 13));
    const e = 2n ** 52n;
    const expected = (9700n * e) / (100n * (e - h));
    expect(crashPointX100(seed, 'abc', 3, 300)).toBe(expected < 100n ? 100n : expected);
  });

  it('reaches each target about (1 - edge) / target of the time', () => {
    const n = 200_000;
    const seed = hashSeed('distribution');
    let at1 = 0;
    let at2 = 0;
    let at10 = 0;
    for (let i = 0; i < n; i++) {
      const c = crashPointX100(seed, 'client', i, 300);
      if (c === 100n) at1++;
      if (c >= 200n) at2++;
      if (c >= 1000n) at10++;
    }
    expect(at2 / n).toBeCloseTo(0.485, 2);
    expect(at10 / n).toBeCloseTo(0.097, 2);
    // Everything below 1.01× counts as an instant pop: 1 - 0.97 / 1.01 ≈ 3.96%.
    expect(at1 / n).toBeCloseTo(0.0396, 2);
  });
});

describe('multiplier over time', () => {
  it('starts at 1.00× and grows', () => {
    expect(multiplierAt(0)).toBe(100);
    expect(multiplierAt(5800)).toBe(200);
    expect(multiplierAt(19189)).toBe(1000);
  });

  it('msToReach is the first millisecond at the target', () => {
    for (const x of [101, 150, 200, 999, 1000, 5000, 100000]) {
      const ms = msToReach(x);
      expect(multiplierAt(ms)).toBeGreaterThanOrEqual(x);
      expect(multiplierAt(ms - 1)).toBeLessThan(x);
    }
    expect(msToReach(100)).toBe(0);
  });
});

describe('planned outcome', () => {
  it('pays the auto cash-out when the balloon gets there', () => {
    expect(plannedOutcome(300n, 5000, 200)).toEqual({ kind: 'WIN', atX100: 200, reason: 'AUTO', afterMs: msToReach(200) });
  });
  it('pays at the cap when the balloon flies past it', () => {
    expect(plannedOutcome(9000n, 2000, null)).toMatchObject({ kind: 'WIN', atX100: 2000, reason: 'LIMIT' });
    expect(plannedOutcome(9000n, 2000, 4000)).toMatchObject({ kind: 'WIN', atX100: 2000, reason: 'LIMIT' });
  });
  it('loses when it pops first', () => {
    expect(plannedOutcome(150n, 2000, 200)).toEqual({ kind: 'BUST', afterMs: msToReach(150) });
    expect(plannedOutcome(100n, 2000, 101)).toEqual({ kind: 'BUST', afterMs: 0 });
  });
  it('rounds payouts down', () => {
    expect(payoutFor(333n, 150)).toBe(499n);
  });
});

describe('reserve limits', () => {
  const s: RiskSettings = {
    flightRiskBps: 100,
    totalRiskBps: 1000,
    maxMultiplierX100: 100000,
    minBetMinor: 100n,
    maxBetMinor: 10_000_000n,
  };

  it('allows 1% of the free reserve per flight', () => {
    const l = currentLimits({ reserveMinor: 10_000_000n, committedMinor: 0n, openRiskMinor: 0n }, s);
    expect(l.flightLimitMinor).toBe(100_000n);
    expect(l.maxBetMinor).toBe(100_000n);
  });

  it('counts what open flights could still win', () => {
    const l = currentLimits({ reserveMinor: 10_000_000n, committedMinor: 5_000_000n, openRiskMinor: 900_000n }, s);
    // free = 5,000,000 → 1% = 50,000; total room = 1,000,000 - 900,000 = 100,000
    expect(l.flightLimitMinor).toBe(50_000n);
    const tight = currentLimits({ reserveMinor: 10_000_000n, committedMinor: 1_000_000n, openRiskMinor: 980_000n }, s);
    expect(tight.flightLimitMinor).toBe(20_000n);
  });

  it('never allows anything when the reserve is empty or fully committed', () => {
    expect(currentLimits({ reserveMinor: 0n, committedMinor: 0n, openRiskMinor: 0n }, s).maxBetMinor).toBe(0n);
    expect(currentLimits({ reserveMinor: 100n, committedMinor: 200n, openRiskMinor: 0n }, s).maxBetMinor).toBe(0n);
  });

  it('caps each bet so its house loss stays within the limit', () => {
    expect(capFor(5_000n, 100_000n, 100000)).toBe(2100);
    expect(capFor(1n, 100_000n, 100000)).toBe(100000);
    for (const bet of [100n, 777n, 5_000n, 99_999n, 100_000n]) {
      const r = checkBet(bet, { reserveMinor: 10_000_000n, committedMinor: 0n, openRiskMinor: 0n }, s);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.maxPayoutMinor - bet).toBeLessThanOrEqual(100_000n);
        expect(r.capX100).toBeGreaterThanOrEqual(200);
      }
    }
  });

  it('refuses bets below the minimum or above the limit', () => {
    const state = { reserveMinor: 10_000_000n, committedMinor: 0n, openRiskMinor: 0n };
    expect(checkBet(99n, state, s)).toMatchObject({ ok: false, reason: 'BELOW_MIN' });
    expect(checkBet(100_001n, state, s)).toMatchObject({ ok: false, reason: 'ABOVE_MAX' });
  });

  it('keeps the reserve solvent through a long adversarial run', () => {
    // Players always bet the maximum and aim for the cap; the reserve must never fall below what it owes.
    let reserve = 10_000_000n;
    let seedN = 0;
    for (let i = 0; i < 20_000; i++) {
      const state = { reserveMinor: reserve, committedMinor: 0n, openRiskMinor: 0n };
      const limits = currentLimits(state, s);
      if (limits.maxBetMinor < s.minBetMinor) break;
      const bet = limits.maxBetMinor;
      const r = checkBet(bet, state, s);
      if (!r.ok) throw new Error('refused');
      reserve += bet;
      const crash = crashPointX100('stress', 'p', seedN++, 300);
      const o = plannedOutcome(crash, r.capX100, null);
      if (o.kind === 'WIN') reserve -= payoutFor(bet, o.atX100);
      expect(reserve).toBeGreaterThan(0n);
    }
  });
});
