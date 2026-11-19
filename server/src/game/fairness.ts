import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Provably fair pop points. This file is the published specification: anyone can recompute a flight with it.
 *
 *   h      = first 52 bits (13 hex digits) of HMAC-SHA256(key = serverSeed, message = `${clientSeed}:${nonce}`)
 *   E      = 2^52
 *   crash  = floor( (10000 - edgeBps) * E / (100 * (E - h)) ), at least 100
 *
 * `crash` is the multiplier times 100 (250 = 2.50×). For any m, P(crash >= m) = (1 - edge) / (m / 100): with a 3% edge
 * a 2.00× target is reached 48.5% of the time, and every strategy returns 97% of what is bet over time.
 * Cash-outs start at 1.01×, so flights with crash = 100 are lost to everyone: about 4% with a 3% edge.
 *
 * The server seed is random and kept secret while it is in use; its SHA-256 hash is shown to the player before
 * the first bet with it. When the player retires the pair, the seed is revealed so every past flight can be checked.
 */

const E = 2n ** 52n;

export function crashPointX100(serverSeed: string, clientSeed: string, nonce: number, edgeBps: number): bigint {
  if (!Number.isInteger(edgeBps) || edgeBps < 0 || edgeBps >= 10000) throw new RangeError('edgeBps must be 0..9999');
  if (!Number.isInteger(nonce) || nonce < 0) throw new RangeError('nonce must be a non-negative integer');
  const digest = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  const h = BigInt(`0x${digest.slice(0, 13)}`);
  const crash = (BigInt(10000 - edgeBps) * E) / (100n * (E - h));
  return crash < 100n ? 100n : crash;
}

export const hashSeed = (serverSeed: string): string => createHash('sha256').update(serverSeed).digest('hex');

export const newServerSeed = (): string => randomBytes(32).toString('hex');

export const newClientSeed = (): string => randomBytes(8).toString('hex');

/** Client seeds are short printable text the player may choose. */
export const CLIENT_SEED_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
