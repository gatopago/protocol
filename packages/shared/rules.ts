import { encodeFunctionData, erc20Abi, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { depositCalls, withdrawCalls } from './earn';
import type { WalletNetwork } from './networks';

/**
 * Money rules: what an account does with its money in one operation, signed once. The calls of a
 * rule run together or not at all (one ERC-7821 batch), so a failed payment never leaves the rest
 * half done.
 */

/** One recipient of a payout and what they receive (the token's units). */
export interface Payout {
  readonly to: Address;
  readonly amount: bigint;
}

/** Recipients one payout pays at most: enough for a team, small enough to review. */
export const MAX_PAYOUTS = 10;

/**
 * The total of `payouts`, refusing what should not be signed: no recipients or too many, an
 * invalid or repeated address (merge them instead), or a zero amount.
 */
export function payoutTotal(payouts: readonly Payout[]): bigint {
  if (payouts.length === 0 || payouts.length > MAX_PAYOUTS) throw new Error('PAYOUT_SIZE');
  const seen = new Set<string>();
  let total = 0n;
  for (const { to, amount } of payouts) {
    if (!isAddress(to) || to === zeroAddress) throw new Error('INVALID_ADDRESS');
    if (seen.has(to.toLowerCase())) throw new Error('DUPLICATE_RECIPIENT');
    if (amount <= 0n) throw new Error('INVALID_AMOUNT');
    seen.add(to.toLowerCase());
    total += amount;
  }
  return total;
}

/** Pays every recipient in `token`. */
export function payoutCalls(
  token: Address,
  payouts: readonly Payout[],
): { to: Address; data: Hex }[] {
  payoutTotal(payouts);
  return payouts.map(({ to, amount }) => ({
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
  }));
}

/**
 * Pays from savings: withdraws exactly what the payouts add up to from Aave and pays them, so the
 * money earns until the moment it is spent.
 */
export function payFromSavingsCalls(
  network: WalletNetwork,
  account: Address,
  payouts: readonly Payout[],
): { to: Address; data: Hex }[] {
  return [
    ...withdrawCalls(network, account, payoutTotal(payouts)),
    ...payoutCalls(network.usdc, payouts),
  ];
}

/**
 * Splits money that arrived: pays each share and saves `save` in Aave; what is left stays
 * available. A split may only pay, or only save.
 */
export function splitCalls(
  network: WalletNetwork,
  account: Address,
  split: { payouts: readonly Payout[]; save: bigint },
): { to: Address; data: Hex }[] {
  if (split.save < 0n || (split.payouts.length === 0 && split.save === 0n))
    throw new Error('EMPTY_SPLIT');
  return [
    ...(split.payouts.length > 0 ? payoutCalls(network.usdc, split.payouts) : []),
    ...(split.save > 0n ? depositCalls(network, account, split.save) : []),
  ];
}

/** Basis points of a whole (100% = 10 000). */
const WHOLE = 10_000n;

/**
 * The amounts of a split of `amount`: each recipient's share and the saved share, in basis points.
 * Shares round down, so the rounding dust stays available; together they cannot exceed the whole.
 */
export function splitAmounts(
  amount: bigint,
  shares: { payouts: readonly { to: Address; bps: number }[]; saveBps: number },
): { payouts: Payout[]; save: bigint } {
  const parts = [...shares.payouts.map((share) => share.bps), shares.saveBps];
  if (parts.some((bps) => !Number.isInteger(bps) || bps < 0)) throw new Error('INVALID_SHARE');
  if (parts.reduce((sum, bps) => sum + BigInt(bps), 0n) > WHOLE) throw new Error('SHARES_OVER_100');
  const part = (bps: number) => (amount * BigInt(bps)) / WHOLE;
  return {
    payouts: shares.payouts
      .map(({ to, bps }) => ({ to, amount: part(bps) }))
      .filter((payout) => payout.amount > 0n),
    save: part(shares.saveBps),
  };
}
