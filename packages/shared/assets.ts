import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { walletNetwork } from './networks';

/**
 * What a person holds, as coins rather than networks: USDC is one balance wherever it is, each
 * network's own coin is a coin (networks that share one, like ETH, add up), and other dollars
 * (AUSD) are coins of their own, never added to USDC. Screens show these; networks stay
 * underneath, for the advanced view.
 */
export interface WalletAsset {
  /** `USDC`, a token's symbol, or the native coin's symbol. */
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** Where it lives: each network and its token contract (`null` for the native coin). */
  readonly holdings: readonly WalletHolding[];
}

export interface WalletHolding {
  readonly networkId: string;
  readonly token: Address | null;
  /** Gives test tokens to anyone, on testnets. */
  readonly faucet?: Address;
}

/** Display names of native coins; any other uses the network's own name for it. */
const NAMES: Record<string, string> = { ETH: 'Ether', AVAX: 'Avalanche', MON: 'Monad' };

/**
 * The coins of the wallet networks `networkIds`: USDC first, then the networks' other tokens, then
 * each native coin; a coin on several networks appears once.
 */
export function walletAssets(networkIds: readonly string[]): WalletAsset[] {
  const coins = new Map<string, { name: string; decimals: number; holdings: WalletHolding[] }>();
  const add = (symbol: string, name: string, decimals: number, holding: WalletHolding) => {
    const coin = coins.get(symbol) ?? { name, decimals, holdings: [] };
    coin.holdings.push(holding);
    coins.set(symbol, coin);
  };
  for (const networkId of networkIds)
    add('USDC', 'USD Coin', 6, { networkId, token: walletNetwork(networkId).usdc });
  for (const networkId of networkIds)
    for (const token of walletNetwork(networkId).tokens ?? [])
      add(token.symbol, token.name, token.decimals, {
        networkId,
        token: token.address,
        ...(token.faucet ? { faucet: token.faucet } : {}),
      });
  for (const networkId of networkIds) {
    const { symbol, name, decimals } = walletNetwork(networkId).chain.nativeCurrency;
    add(symbol, NAMES[symbol] ?? name, decimals, { networkId, token: null });
  }
  return [...coins].map(([symbol, coin]) => ({ symbol, ...coin }));
}

/**
 * The total of `asset`, given each holding's balance (`read`); `undefined` while any is unread,
 * `null` when one could not be read.
 */
export function assetBalance(
  asset: WalletAsset,
  read: (holding: WalletHolding) => bigint | null | undefined,
): bigint | null | undefined {
  let total = 0n;
  for (const holding of asset.holdings) {
    const value = read(holding);
    if (value == null) return value;
    total += value;
  }
  return total;
}

const faucetAbi = parseAbi(['function requestFunds(address to)']);

/** Asks a testnet faucet (Agora's, for AUSD) to send test tokens to `to`. */
export function faucetCall(faucet: Address, to: Address): { to: Address; data: Hex } {
  return {
    to: faucet,
    data: encodeFunctionData({ abi: faucetAbi, functionName: 'requestFunds', args: [to] }),
  };
}
