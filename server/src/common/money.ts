/** Largest amount a single ledger line may carry, in minor units. */
export const MAX_AMOUNT_MINOR = 10n ** 15n;

/** Integer minor units as decimal text, e.g. (12345n, 2) -> "123.45". Money never passes through a float. */
export function formatMinor(amountMinor: bigint, minorUnits: number): string {
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(minorUnits + 1, '0');
  const whole = digits.slice(0, digits.length - minorUnits);
  const fraction = minorUnits > 0 ? `.${digits.slice(-minorUnits)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** A multiplier ×100 as text, e.g. 250 -> "2.50". */
export const formatX100 = (x100: number | bigint): string => formatMinor(BigInt(x100), 2);
