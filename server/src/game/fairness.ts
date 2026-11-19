import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Provably fair pop points for shared rounds. This file is the published specification.
 *
 * Seeds come from a hash chain made before any round is played:
 *   seed[L] = random; seed[i - 1] = SHA-256(seed[i]); commitment = seed[0], published in advance.
 * Round i of the chain uses seed[i] and reveals it when the round ends. Anyone can check SHA-256(seed[i]) equals
 * the seed of the round before (the commitment for i = 1). Since SHA-256 cannot be reversed, every future seed
 * was fixed the moment the commitment was published.
 *
 *   h      = first 52 bits (13 hex digits) of HMAC-SHA256(key = seed, message = salt)
 *   E      = 2^52
 *   crash  = floor( (10000 - edgeBps) * E / (100 * (E - h)) ), at least 100
 *
 * `crash` is the multiplier ×100 (250 = 2.50×). For any m, P(crash >= m) = (1 - edge) / (m / 100): with a 3% edge
 * a 2.00× target is reached 48.5% of the time and every strategy returns 97% of what is bet over time.
 * Cash-outs start at 1.01×, so a round with crash = 100 is lost to everyone: about 4% of rounds.
 */

const E = 2n ** 52n;

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function crashFromDigest(hexDigest: string, edgeBps: number): bigint {
  if (!Number.isInteger(edgeBps) || edgeBps < 0 || edgeBps >= 10000) throw new RangeError('edgeBps must be 0..9999');
  const h = BigInt(`0x${hexDigest.slice(0, 13)}`);
  const crash = (BigInt(10000 - edgeBps) * E) / (100n * (E - h));
  return crash < 100n ? 100n : crash;
}

export function roundCrashX100(seed: string, salt: string, edgeBps: number): bigint {
  return crashFromDigest(createHmac('sha256', seed).update(salt).digest('hex'), edgeBps);
}

/** seed[index] of a chain whose last seed is `topSeed`: hash it (length - index) times. */
export function chainSeed(topSeed: string, length: number, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > length) throw new RangeError('index outside the chain');
  let seed = topSeed;
  for (let i = length; i > index; i--) seed = sha256(seed);
  return seed;
}

export const newTopSeed = (): string => randomBytes(32).toString('hex');
