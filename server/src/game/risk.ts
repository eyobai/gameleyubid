/**
 * Bankruptcy protection. The reserve pays winners; these rules make sure it can always pay every open flight and
 * that no bet, and no group of bets, can cost it more than a small share of what it holds.
 *
 *   base       = reserve - bets of flights still in the air  (the house's own money; open bets may be paid back)
 *   per flight : the most one new flight can cost the house (payout - bet) <= flightRiskBps of base
 *   all open   : the most all open flights together can cost the house    <= totalRiskBps  of base
 *   solvency   : the reserve always holds every open flight's largest payout
 *
 * The base does not move when bets come in, so every player sees the same limit while others are flying, until
 * the total for all open flights is used up. Because each flight's cost to the house is at least its bet (every
 * cap is at least 2×), open bets plus their costs stay within 2 × totalRiskBps of base, far inside the reserve.
 *
 * A bet larger than its limit is refused. A bet within it gets a cap: the multiplier at which its winnings reach the
 * limit. The flight is cashed out there automatically, so the payout can never be larger than promised. Because a
 * bet may not exceed the limit itself, every cap is at least 2.00×.
 */
export interface RiskSettings {
  flightRiskBps: number;
  totalRiskBps: number;
  maxMultiplierX100: number;
  minBetMinor: bigint;
  maxBetMinor: bigint;
}

export interface ReserveState {
  reserveMinor: bigint;
  /** Sum of the bets of open flights (already in the reserve). */
  openBetsMinor: bigint;
  /** Sum of max payouts of open flights. */
  committedMinor: bigint;
  /** Sum of (max payout - bet) of open flights: what they could cost the house. */
  openRiskMinor: bigint;
}

export interface Limits {
  /** Reserve minus every open flight's largest payout: what a withdrawal may take. */
  freeMinor: bigint;
  /** Reserve minus open bets: what the limits are a share of. */
  baseMinor: bigint;
  /** Largest house loss allowed for one new flight right now. Also the largest bet. */
  flightLimitMinor: bigint;
  maxBetMinor: bigint;
}

export function currentLimits(state: ReserveState, s: RiskSettings): Limits {
  const free = state.reserveMinor - state.committedMinor;
  const freeMinor = free > 0n ? free : 0n;
  const b = state.reserveMinor - state.openBetsMinor;
  const baseMinor = b > 0n ? b : 0n;
  const perFlight = (baseMinor * BigInt(s.flightRiskBps)) / 10000n;
  const totalRoom = (baseMinor * BigInt(s.totalRiskBps)) / 10000n - state.openRiskMinor;
  let limit = perFlight < totalRoom ? perFlight : totalRoom;
  // Never promise more than the reserve holds beyond what it already owes (a bet of `limit` can cost `limit`).
  if (limit > freeMinor) limit = freeMinor;
  if (limit < 0n) limit = 0n;
  const maxBet = limit < s.maxBetMinor ? limit : s.maxBetMinor;
  return { freeMinor, baseMinor, flightLimitMinor: limit, maxBetMinor: maxBet };
}

/** The cap for a bet, as a multiplier ×100, so that bet × (cap - 1) <= limit. */
export function capFor(betMinor: bigint, limitMinor: bigint, maxMultiplierX100: number): number {
  const byLimit = 100n + (limitMinor * 100n) / betMinor;
  const cap = byLimit < BigInt(maxMultiplierX100) ? Number(byLimit) : maxMultiplierX100;
  return cap;
}

export type BetCheck =
  | { ok: true; capX100: number; maxPayoutMinor: bigint }
  | { ok: false; reason: 'BELOW_MIN' | 'ABOVE_MAX'; limits: Limits };

export function checkBet(betMinor: bigint, state: ReserveState, s: RiskSettings): BetCheck {
  const limits = currentLimits(state, s);
  if (betMinor < s.minBetMinor) return { ok: false, reason: 'BELOW_MIN', limits };
  if (betMinor > limits.maxBetMinor) return { ok: false, reason: 'ABOVE_MAX', limits };
  const capX100 = capFor(betMinor, limits.flightLimitMinor, s.maxMultiplierX100);
  const maxPayoutMinor = (betMinor * BigInt(capX100)) / 100n;
  // Last line of defence: after taking the bet, the reserve must still hold every open flight's largest payout.
  if (state.reserveMinor + betMinor - state.committedMinor - maxPayoutMinor < 0n) return { ok: false, reason: 'ABOVE_MAX', limits };
  return { ok: true, capX100, maxPayoutMinor };
}
