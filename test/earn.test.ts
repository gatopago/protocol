import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { aavePoolAbi, depositCalls, supplyApy, withdrawCalls } from '../packages/shared/earn';
import { walletNetworks } from '../packages/shared/networks';

const arbitrum = walletNetworks['eip155:421614'];
const account = '0x75464f762bc50d0A0B127ab5a085504BF102Bb88';

describe('Aave savings', () => {
  it('approves exactly the amount and supplies it on behalf of the account', () => {
    const [approve, supply] = depositCalls(arbitrum, account, 5_000_000n);
    expect(approve.to).toBe(arbitrum.usdc);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data }).args).toEqual([
      arbitrum.aave.pool,
      5_000_000n,
    ]);
    expect(supply.to).toBe(arbitrum.aave.pool);
    expect(decodeFunctionData({ abi: aavePoolAbi, data: supply.data }).args).toEqual([
      arbitrum.usdc,
      5_000_000n,
      account,
      0,
    ]);
  });

  it('withdraws everything with Aave’s max sentinel, and refuses networks without a market', () => {
    const [withdraw] = withdrawCalls(arbitrum, account, 'all');
    expect(decodeFunctionData({ abi: aavePoolAbi, data: withdraw.data }).args).toEqual([
      arbitrum.usdc,
      maxUint256,
      account,
    ]);
    expect(() => depositCalls(walletNetworks['eip155:10143'], account, 1n)).toThrow(
      'AAVE_UNAVAILABLE',
    );
  });

  it('compounds the per-second liquidity rate into an APY', () => {
    // 4.2932% APR in ray (Arbitrum Sepolia, October 2026) is about 4.387% APY.
    expect(supplyApy(42_932_425_300_715_007_484_200_990n)).toBeCloseTo(4.387, 2);
    expect(supplyApy(0n)).toBe(0);
  });
});
