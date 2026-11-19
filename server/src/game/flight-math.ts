/**
 * How the multiplier grows with time, and how a flight's outcome follows from its pop point, cap and auto cash-out.
 * Pure functions; the server clock supplies the elapsed time.
 *
 * Multiplier ×100 after `ms` milliseconds: floor(100 · e^(GROWTH · ms / 1000)). 2× after ~5.8 s, 10× after ~19 s.
 */
export const GROWTH_PER_SECOND = 0.12;

export function multiplierAt(ms: number): number {
  if (ms <= 0) return 100;
  return Math.floor(100 * Math.exp((GROWTH_PER_SECOND * ms) / 1000));
}

/** The first whole millisecond at which the multiplier shows at least `x100`. */
export function msToReach(x100: number | bigint): number {
  const target = Number(x100);
  if (target <= 100) return 0;
  // Beyond any cap the game allows; keeps the arithmetic finite for absurd pop points.
  if (target > 1e9) return msToReach(1e9);
  let ms = Math.max(0, Math.floor((1000 * Math.log(target / 100)) / GROWTH_PER_SECOND) - 2);
  while (multiplierAt(ms) < target) ms++;
  return ms;
}

export type CashoutReason = 'PLAYER' | 'AUTO' | 'LIMIT';

export type PlannedOutcome =
  | { kind: 'WIN'; atX100: number; reason: Exclude<CashoutReason, 'PLAYER'>; afterMs: number }
  | { kind: 'BUST'; afterMs: number };

/**
 * What happens if the player does nothing: paid at the auto cash-out or the cap, whichever comes first, if the balloon
 * gets there; otherwise lost when it pops. `afterMs` is when that is decided.
 */
export function plannedOutcome(crashX100: bigint, capX100: number, autoX100: number | null): PlannedOutcome {
  const auto = autoX100 !== null && autoX100 < capX100 ? autoX100 : null;
  const target = auto ?? capX100;
  if (target >= 101 && BigInt(target) <= crashX100) {
    return { kind: 'WIN', atX100: target, reason: auto !== null ? 'AUTO' : 'LIMIT', afterMs: msToReach(target) };
  }
  return { kind: 'BUST', afterMs: msToReach(crashX100) };
}

/** Payout for a bet cashed out at `x100`, rounded down to the minor unit. */
export const payoutFor = (betMinor: bigint, x100: number): bigint => (betMinor * BigInt(x100)) / 100n;
