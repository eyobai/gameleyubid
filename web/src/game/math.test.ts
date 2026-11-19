import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromMinor, toMinor } from '../lib/money';
import { multiplierAt, roundCrashX100 } from './math';

describe('browser fairness check', () => {
  it('matches the server formula', async () => {
    const seed = 'ab'.repeat(32);
    for (let i = 0; i < 50; i++) {
      const salt = `salt-${i}`;
      const h = BigInt('0x' + createHmac('sha256', seed).update(salt).digest('hex').slice(0, 13));
      const e = 2n ** 52n;
      const c = (9700n * e) / (100n * (e - h));
      expect(await roundCrashX100(seed, salt, 300)).toBe(c < 100n ? 100n : c);
    }
  });
  it('grows like the server', () => {
    expect(multiplierAt(0)).toBe(100);
    expect(multiplierAt(5800)).toBe(200);
  });
});

describe('money', () => {
  it('parses and formats without floats', () => {
    expect(toMinor('12.5')).toBe(1250n);
    expect(toMinor('0.1')).toBe(10n);
    expect(toMinor('1.234')).toBeNull();
    expect(toMinor('-3')).toBeNull();
    expect(fromMinor(123456789n)).toBe('1,234,567.89');
  });
});
