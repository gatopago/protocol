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
  /**
   * Circle CCTP V2: the network's domain, TokenMessengerV2 and the TokenMinterV2 it burns through
   * (an account's USDC goes to the minter before the burn). `fast` when Fast Transfer applies (on
   * Avalanche and Monad, Standard is already fast).
   */
  readonly cctp: {
    readonly domain: number;
    readonly tokenMessenger: Address;
    readonly tokenMinter: Address;
    readonly fast: boolean;
  };
  /**
   * Flow's `GatoPagoPaymentRouter` (`contracts/script/DeployPayments.s.sol`); its address depends on
   * the network's USDC, so it differs per network.
   */
  readonly paymentRouter: Address;
  /** Aave V3 USDC market, where the network has one: its Pool and the aToken it mints. */
  readonly aave?: { readonly pool: Address; readonly aToken: Address };
  /**
   * Uniswap v3, where the network has USDC liquidity: its factory, SwapRouter02, QuoterV2 and the
   * WETH9 they use.
   */
  readonly uniswap?: {
    readonly factory: Address;
    readonly router: Address;
    readonly quoter: Address;
    readonly weth: Address;
  };
}

/** TokenMessengerV2 on every CCTP testnet (developers.circle.com/cctp/evm-smart-contracts). */
const CCTP_TESTNET_TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
/** Its `localMinter()` on every CCTP testnet. */
const CCTP_TESTNET_TOKEN_MINTER = '0xb43db544E2c27092c107639Ad201b3dEfAbcF192';

/** Networks GatoPago wallets run on, by CAIP-2 id. */
export const walletNetworks = {
  'eip155:421614': {
    chain: arbitrumSepolia,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    l1Fees: 'arbitrum',
    cctp: {
      domain: 3,
      tokenMessenger: CCTP_TESTNET_TOKEN_MESSENGER,
      tokenMinter: CCTP_TESTNET_TOKEN_MINTER,
      fast: true,
    },
    paymentRouter: '0x1536b89c24b4c5296Ea67d3a5d0BFB7a3dc1c792',
    aave: {
      pool: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
      aToken: '0x460b97BD498E1157530AEb3086301d5225b91216',
    },
    uniswap: {
      factory: '0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e',
      router: '0x101F443B4d1b059569D643917553c771E1b9663E',
      quoter: '0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B',
      weth: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    },
  },
  'eip155:43113': {
    chain: avalancheFuji,
    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65',
    cctp: {
      domain: 1,
      tokenMessenger: CCTP_TESTNET_TOKEN_MESSENGER,
      tokenMinter: CCTP_TESTNET_TOKEN_MINTER,
      fast: false,
    },
    paymentRouter: '0x52a0a15d762eB68092b5B45D958C4244233b7F58',
    aave: {
      pool: '0x8B9b2AF4afB389b4a70A474dfD4AdCD4a302bb40',
      aToken: '0x9CFcc1B289E59FBe1E769f020C77315DF8473760',
    },
  },
  'eip155:10143': {
    chain: monadTestnet,
    usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
    cctp: {
      domain: 15,
      tokenMessenger: CCTP_TESTNET_TOKEN_MESSENGER,
      tokenMinter: CCTP_TESTNET_TOKEN_MINTER,
      fast: false,
    },
    paymentRouter: '0x18F716B0CCAe35471986b65b8a8A15594Ab5BE40',
  },
} as const satisfies Record<string, WalletNetwork>;

export type WalletNetworkId = keyof typeof walletNetworks;

export function walletNetwork(id: string): WalletNetwork {
  if (!Object.hasOwn(walletNetworks, id)) throw new Error(`UNSUPPORTED_WALLET_NETWORK: ${id}`);
  return walletNetworks[id as WalletNetworkId];
}
