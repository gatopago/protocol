import { describe, expect, it } from 'vitest';
import { assetBalance, walletAssets } from '../packages/shared/assets';
import { walletNetworks } from '../packages/shared/networks';

const read =
  (values: Record<string, bigint | null>) =>
  ({ networkId }: { networkId: string }) =>
    values[networkId];

describe('wallet assets', () => {
  const ids = ['eip155:421614', 'eip155:43113', 'eip155:10143'];

  it('shows coins, not networks: USDC once, other dollars, then each network coin', () => {
    const assets = walletAssets(ids);
    expect(assets.map(({ symbol, name }) => [symbol, name])).toEqual([
      ['USDC', 'USD Coin'],
      ['AUSD', 'Agora Dollar'],
      ['ETH', 'Ether'],
      ['AVAX', 'Avalanche'],
      ['MON', 'Monad'],
    ]);
    expect(assets[0].holdings).toEqual(
      ids.map((networkId) => ({
        networkId,
        token: walletNetworks[networkId as keyof typeof walletNetworks].usdc,
      })),
    );
  });

  it('keeps other dollars apart, with the network that holds them and its faucet', () => {
    const ausd = walletAssets(ids).find((asset) => asset.symbol === 'AUSD')!;
    expect(ausd.holdings).toEqual([
      {
        networkId: 'eip155:10143',
        token: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
        faucet: '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C',
      },
    ]);
    // Without Monad configured, AUSD is not a coin of the wallet.
    expect(walletAssets(['eip155:421614']).map(({ symbol }) => symbol)).toEqual(['USDC', 'ETH']);
  });

  it('lists XLM last when Stellar is on, as its native coin', () => {
    const assets = walletAssets(['eip155:421614'], 'stellar:testnet');
    expect(assets.map(({ symbol }) => symbol)).toEqual(['USDC', 'ETH', 'XLM']);
    expect(assets.at(-1)).toEqual({
      symbol: 'XLM',
      name: 'Stellar Lumens',
      decimals: 7,
      holdings: [{ networkId: 'stellar:testnet', token: null }],
    });
  });

  it('adds up a coin across its networks, once every one is read', () => {
    const [usdc] = walletAssets(ids);
    const eth = walletAssets(ids).find((asset) => asset.symbol === 'ETH')!;
    expect(
      assetBalance(usdc, read({ 'eip155:421614': 1n, 'eip155:43113': 2n, 'eip155:10143': 3n })),
    ).toBe(6n);
    expect(assetBalance(eth, read({ 'eip155:421614': 5n }))).toBe(5n);
    expect(assetBalance(usdc, read({ 'eip155:421614': 1n }))).toBe(undefined);
    expect(
      assetBalance(usdc, read({ 'eip155:421614': 1n, 'eip155:43113': null, 'eip155:10143': 3n })),
    ).toBe(null);
  });
});
