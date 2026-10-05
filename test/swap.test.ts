import { describe, expect, it } from 'vitest';
import { walletNetworks } from '../packages/shared/networks';
import { swapPools } from '../packages/shared/swap';

describe('Uniswap swaps', () => {
  it('computes the USDC/WETH pools the factory deployed', () => {
    // UniswapV3Factory.getPool(USDC, WETH, fee) on Arbitrum Sepolia, October 2026.
    expect(swapPools(walletNetworks['eip155:421614'])).toEqual([
      '0x6F112d524DC998381C09b4e53C7e5e2cc260f877',
      '0x66EEAB70aC52459Dd74C6AD50D578Ef76a441bbf',
      '0x3eCedaB7E9479E29B694d8590dc34e0Ce6059868',
    ]);
    expect(() => swapPools(walletNetworks['eip155:10143'])).toThrow('SWAP_UNAVAILABLE');
  });
});
