/** Same growth as the server (server/src/game/flight-math.ts). The server's clock decides; this only animates. */
export const GROWTH_PER_SECOND = 0.12;
export const multiplierAt = (ms: number) => (ms <= 0 ? 100 : Math.floor(100 * Math.exp((GROWTH_PER_SECOND * ms) / 1000)));

/** The published pop-point formula for a round, recomputed in the browser with Web Crypto. */
export async function roundCrashX100(seed: string, salt: string, edgeBps: number): Promise<bigint> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(salt)));
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
  const h = BigInt(`0x${hex.slice(0, 13)}`);
  const e = 2n ** 52n;
  const crash = (BigInt(10000 - edgeBps) * e) / (100n * (e - h));
  return crash < 100n ? 100n : crash;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
