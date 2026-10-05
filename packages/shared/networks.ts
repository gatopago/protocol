import type { Address, Chain } from 'viem';
import { arbitrumSepolia, avalancheFuji, monadTestnet } from 'viem/chains';
import type { WalletContracts } from './wallet';

/**
 * CREATE2 addresses of `contracts/script/DeployWallet.s.sol`, identical on every network (checked
 * against the compiled contracts by `test/networks.test.ts`). The paymaster address includes its
 * sponsor signer and owner, on testnets both `0x75464f762bc50d0A0B127ab5a085504BF102Bb88`.
 */
export const walletContracts: WalletContracts = {
  webAuthnVerifier: '0x3BF33A59064bB8f9006bfF94A20Cc8917D7876E8',
  factory: '0x4A000246131C2DEd46ff6eA047808E708Fa0da02',
  paymaster: '0x9EEE399a75C2C06b528E50f05fA6d61aAcE813b1',
};

export interface WalletNetwork {
  readonly chain: Chain;
  /** Circle USDC. */
  readonly usdc: Address;
  /** Transactions also pay for L1 data (priced into `preVerificationGas` by the bundler). */
  readonly l1Fees?: 'arbitrum';
}

/** Networks GatoPago wallets run on, by CAIP-2 id. */
export const walletNetworks = {
  'eip155:421614': {
    chain: arbitrumSepolia,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    l1Fees: 'arbitrum',
  },
  'eip155:43113': { chain: avalancheFuji, usdc: '0x5425890298aed601595a70AB815c96711a31Bc65' },
  'eip155:10143': { chain: monadTestnet, usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3' },
} as const satisfies Record<string, WalletNetwork>;

export type WalletNetworkId = keyof typeof walletNetworks;

export function walletNetwork(id: string): WalletNetwork {
  if (!Object.hasOwn(walletNetworks, id)) throw new Error(`UNSUPPORTED_WALLET_NETWORK: ${id}`);
  return walletNetworks[id as WalletNetworkId];
}
