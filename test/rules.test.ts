import { describe, expect, it } from 'vitest';
import { zeroAddress, type Address } from 'viem';
import { MAX_PAYOUTS, payoutTotal, splitAmounts } from '../packages/shared/rules';

const ana: Address = '0x00000000000000000000000000000000000000a1';
const beto: Address = '0x00000000000000000000000000000000000000b2';

describe('money rules', () => {
  it('only accepts payouts that are safe to sign', () => {
    expect(
      payoutTotal([
        { to: ana, amount: 2n },
        { to: beto, amount: 3n },
      ]),
    ).toBe(5n);
    expect(() => payoutTotal([])).toThrow('PAYOUT_SIZE');
    const many = Array.from({ length: MAX_PAYOUTS + 1 }, (_, i) => ({
      to: `0x${(i + 1).toString(16).padStart(40, '0')}` as Address,
      amount: 1n,
    }));
    expect(() => payoutTotal(many)).toThrow('PAYOUT_SIZE');
    expect(() => payoutTotal([{ to: zeroAddress, amount: 1n }])).toThrow('INVALID_ADDRESS');
    expect(() => payoutTotal([{ to: ana, amount: 0n }])).toThrow('INVALID_AMOUNT');
    // The same person twice is a mistake to fix before signing, not two payments.
    expect(() =>
      payoutTotal([
        { to: ana, amount: 1n },
        { to: ana.toUpperCase().replace('0X', '0x') as Address, amount: 1n },
      ]),
    ).toThrow('DUPLICATE_RECIPIENT');
  });

  it('splits an amount by shares, leaving the rounding dust available', () => {
    expect(
      splitAmounts(1_000_001n, {
        payouts: [
          { to: ana, bps: 2_500 },
          { to: beto, bps: 0 },
        ],
        saveBps: 1_500,
      }),
    ).toEqual({ payouts: [{ to: ana, amount: 250_000n }], save: 150_000n });
    expect(() => splitAmounts(1n, { payouts: [{ to: ana, bps: 6_000 }], saveBps: 5_000 })).toThrow(
      'SHARES_OVER_100',
    );
    expect(() => splitAmounts(1n, { payouts: [{ to: ana, bps: 0.5 }], saveBps: 0 })).toThrow(
      'INVALID_SHARE',
    );
  });
});
