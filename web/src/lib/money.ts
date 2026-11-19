/** "12.5" -> 1250n with 2 minor units. Null when it is not a plain positive amount. Never uses floats. */
export function toMinor(text: string, minorUnits = 2): bigint | null {
  const m = /^\s*(\d{1,13})(?:\.(\d*))?\s*$/.exec(text);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > minorUnits) return null;
  return BigInt(m[1] + frac.padEnd(minorUnits, '0'));
}

export function fromMinor(minor: bigint | string, minorUnits = 2): string {
  const v = BigInt(minor);
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(minorUnits + 1, '0');
  const whole = digits.slice(0, -minorUnits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}.${digits.slice(-minorUnits)}`;
}

/** 250 -> "2.50×" */
export const x = (x100: number | string | bigint) => `${fromMinor(BigInt(x100), 2)}×`;

/** Adds thousands separators to decimal text from the API, e.g. "199996.00" -> "199,996.00". */
export const group = (text: string | null | undefined) =>
  text == null ? '–' : text.replace(/^(-?)(\d+)/, (_, sign: string, whole: string) => sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
