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
  /**
   * Other coins the wallet holds on this network (ERC-20), each its own coin: they are not added to
   * USDC. `faucet` gives test tokens on testnets.
   */
  readonly tokens?: readonly {
    readonly symbol: string;
    readonly name: string;
    readonly address: Address;
    readonly decimals: number;
    readonly faucet?: Address;
    /**
     * Only the other side of an Instant Settlement pair: a recipient may receive it, but it is not
     * a coin the wallet holds or lists.
     */
    readonly settlementOnly?: true;
  }[];
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
  /**
   * Agora Instant Settlement on this network: a fixed-price pair between two of its coins, and the
   * contract that lets anyone allow-list itself to swap (testnets only).
   */
  readonly instantSettlement?: { readonly pair: Address; readonly whitelister?: Address };
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
    // docs.agora.finance/developer/contract-deployments
    tokens: [
      {
        symbol: 'AUSD',
        name: 'Agora Dollar',
        address: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
        decimals: 6,
        faucet: '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C',
      },
      // Agora's test token, the other side of its testnet Instant Settlement pair: it stands for
      // the coin a recipient keeps (USDC in the mainnet pair).
      {
        symbol: 'CTK',
        name: 'Constant Token (test)',
        address: '0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D',
        decimals: 18,
        settlementOnly: true,
      },
    ],
    // docs.agora.finance/instant-settlement/protocol-deployments
    instantSettlement: {
      pair: '0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae',
      whitelister: '0x7c10F56d6f04a51376393a1C3670e966863F6BD5',
    },
  },
} as const satisfies Record<string, WalletNetwork>;

export type WalletNetworkId = keyof typeof walletNetworks;

export function walletNetwork(id: string): WalletNetwork {
  if (!Object.hasOwn(walletNetworks, id)) throw new Error(`UNSUPPORTED_WALLET_NETWORK: ${id}`);
  return walletNetworks[id as WalletNetworkId];
}

/**
 * Stellar, a secondary network reached through Circle CCTP (domain 27). Accounts are OpenZeppelin
 * `stellar-contracts` smart accounts signed by the same passkeys (stellar.ts). Contract ids are
 * strkeys; USDC and XLM have 7 decimals there.
 */
export interface StellarNetwork {
  /** What the app calls it. */
  readonly name: string;
  readonly passphrase: string;
  readonly testnet: boolean;
  /** Public Stellar RPC, for reads when no other is configured. */
  readonly rpcUrl: string;
  /** Block explorer: `<explorer>/tx/<hash>`. */
  readonly explorer: string;
  /** Circle USDC's Stellar Asset Contract. */
  readonly usdc: string;
  /** The Stellar Asset Contract of lumens (XLM), the network's own coin. */
  readonly xlm: string;
  /**
   * The smart account WASM, the WebAuthn verifier its passkey signers use and the threshold policy
   * that lets any one of them sign (deployments recorded in stellar/smart-account-kit).
   */
  readonly account: {
    readonly wasmHash: string;
    readonly webAuthnVerifier: string;
    /** Verifies Ed25519 signers: keys derived by Mera from a passkey. */
    readonly ed25519Verifier: string;
    readonly thresholdPolicy: string;
  };
  /** Circle CCTP V2: TokenMessengerMinter burns; CctpForwarder mints and pays a Stellar recipient. */
  readonly cctp: {
    readonly domain: number;
    readonly tokenMessengerMinter: string;
    readonly forwarder: string;
    readonly fast: boolean;
  };
}

/** Decimals of XLM, Stellar's own coin. */
export const XLM_DECIMALS = 7;

/** Stellar networks by CAIP-2 id (developers.circle.com/cctp/references/stellar-contracts). */
export const stellarNetworks = {
  'stellar:testnet': {
    name: 'Stellar Testnet',
    passphrase: 'Test SDF Network ; September 2015',
    testnet: true,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    explorer: 'https://stellar.expert/explorer/testnet',
    usdc: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    xlm: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    account: {
      wasmHash: '1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a',
      webAuthnVerifier: 'CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F',
      ed25519Verifier: 'CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4',
      thresholdPolicy: 'CB3FATQKCIRIQOCYRUPCQ2KREQ7T4RPKS7EAEOZWPEPUKWEDRVROBCEG',
    },
    cctp: {
      domain: 27,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      forwarder: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
      // Stellar finalizes in seconds: Standard is already fast.
      fast: false,
    },
  },
} as const satisfies Record<string, StellarNetwork>;

export type StellarNetworkId = keyof typeof stellarNetworks;

export function stellarNetwork(id: string): StellarNetwork {
  if (!Object.hasOwn(stellarNetworks, id)) throw new Error(`UNSUPPORTED_STELLAR_NETWORK: ${id}`);
  return stellarNetworks[id as StellarNetworkId];
}
