// Flow network and rail capabilities. Wallet Core uses pinned V3 manifests.

export type CctpChain = {
  chainId: number;
  name: string;
  /** Circle CCTP domain (distinct from chainId). */
  domain: number;
  /** CCTP v2 TokenMessenger (depositForBurn). */
  tokenMessenger: `0x${string}`;
  /** CCTP v2 MessageTransmitter (receiveMessage). */
  messageTransmitter: `0x${string}`;
  /** Native USDC on this chain. */
  usdc: `0x${string}`;
};

export type PaymentPermitMode = 'eip2612' | 'approve';

/**
 * Universal Checkout is deliberately separate from the wallet's home-chain
 * configuration. `paymentSource` is the fail-closed rollout flag; protocol
 * capabilities alone never make a payment route visible.
 */
export type PaymentNetworkCapabilities = {
  chainId: number;
  name: string;
  isTestnet: boolean;
  isHomeChain: boolean;
  settlementChainId: number;
  cctpDomain: number;
  paymentSource: boolean;
  cctpStandard: boolean;
  cctpFast: boolean;
  localPaymentRouter: `0x${string}` | null;
  cctpPaymentRouter: `0x${string}` | null;
  /** Immutable on-chain ceiling. This is capability, never a fee policy. */
  localPaymentMaxPlatformFeeBps: number | null;
  /** Immutable on-chain ceiling. This is capability, never a fee policy. */
  cctpPaymentMaxPlatformFeeBps: number | null;
  permitMode: PaymentPermitMode;
  usdc: `0x${string}`;
  tokenMessenger: `0x${string}`;
};

// CCTP v2 contracts are deterministic (identical address on every chain). Verified
// against developers.circle.com/cctp (testnet). TokenMessengerV2 / MessageTransmitterV2.
const CCTP_V2_TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const;
const CCTP_V2_MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as const;

/** Circle protocol registry, independent of Account generation. */
export const CCTP_CHAINS: Record<number, CctpChain> = {
  421614: {
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    domain: 3,
    tokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    messageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  },
  84532: {
    chainId: 84532,
    name: 'Base Sepolia',
    domain: 6,
    tokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    messageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  // Inbound sources (cobros hacia Arbitrum). Ethereum Sepolia: instant Fast
  // (~20s, fee) or free Standard (~15-19 min).
  11155111: {
    chainId: 11155111,
    name: 'Ethereum Sepolia',
    domain: 0,
    tokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    messageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  // Avalanche Fuji: instant finality → Standard is already ~8s AND free
  // (Avalanche doesn't even need Fast as a source).
  43113: {
    chainId: 43113,
    name: 'Avalanche Fuji',
    domain: 1,
    tokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    messageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65',
  },
};

/** CCTP info for an EVM chainId, or null if the chain isn't CCTP-enabled here. */
export function getCctpChainByChainId(chainId: number): CctpChain | null {
  return CCTP_CHAINS[chainId] ?? null;
}

const CCTP_V2_MAINNET_TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as const;

/**
 * Frozen Universal Checkout v1 capability/address manifest. The three testnet
 * sources were activated only after successful broadcasts, exact-match source
 * verification, deployment manifests and real end-to-end smokes. Mainnet stays
 * fail-closed until the production fork, audit and operational gates pass.
 */
export const PAYMENT_NETWORKS: Readonly<Record<number, PaymentNetworkCapabilities>> = {
  421614: {
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    isTestnet: true,
    isHomeChain: true,
    settlementChainId: 421614,
    cctpDomain: 3,
    paymentSource: true,
    cctpStandard: true,
    cctpFast: true,
    localPaymentRouter: '0x64e0B48A4D360B235C3fEDe2431D79413aebb7A4',
    cctpPaymentRouter: null,
    localPaymentMaxPlatformFeeBps: 100,
    cctpPaymentMaxPlatformFeeBps: null,
    permitMode: 'eip2612',
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    tokenMessenger: CCTP_V2_TOKEN_MESSENGER,
  },
  84532: {
    chainId: 84532,
    name: 'Base Sepolia',
    isTestnet: true,
    isHomeChain: false,
    settlementChainId: 421614,
    cctpDomain: 6,
    paymentSource: true,
    cctpStandard: true,
    cctpFast: true,
    localPaymentRouter: null,
    cctpPaymentRouter: '0x961C08Bd5a11EFB7264B06d7f14a44FB4d9958Ba',
    localPaymentMaxPlatformFeeBps: null,
    // Current deployment is immutable at zero. Raise only after a verified redeploy.
    cctpPaymentMaxPlatformFeeBps: 0,
    permitMode: 'eip2612',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenMessenger: CCTP_V2_TOKEN_MESSENGER,
  },
  43113: {
    chainId: 43113,
    name: 'Avalanche Fuji',
    isTestnet: true,
    isHomeChain: false,
    settlementChainId: 421614,
    cctpDomain: 1,
    paymentSource: true,
    cctpStandard: true,
    cctpFast: false,
    localPaymentRouter: null,
    cctpPaymentRouter: '0xd8289B87b155e8691Da192b12E12E2b592fE7D1E',
    localPaymentMaxPlatformFeeBps: null,
    // Current deployment is immutable at zero. Raise only after a verified redeploy.
    cctpPaymentMaxPlatformFeeBps: 0,
    permitMode: 'eip2612',
    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65',
    tokenMessenger: CCTP_V2_TOKEN_MESSENGER,
  },
  42161: {
    chainId: 42161,
    name: 'Arbitrum One',
    isTestnet: false,
    isHomeChain: true,
    settlementChainId: 42161,
    cctpDomain: 3,
    paymentSource: false,
    cctpStandard: true,
    cctpFast: true,
    localPaymentRouter: null,
    cctpPaymentRouter: null,
    localPaymentMaxPlatformFeeBps: null,
    cctpPaymentMaxPlatformFeeBps: null,
    permitMode: 'approve',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    tokenMessenger: CCTP_V2_MAINNET_TOKEN_MESSENGER,
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    isTestnet: false,
    isHomeChain: false,
    settlementChainId: 42161,
    cctpDomain: 6,
    paymentSource: false,
    cctpStandard: true,
    cctpFast: true,
    localPaymentRouter: null,
    cctpPaymentRouter: null,
    localPaymentMaxPlatformFeeBps: null,
    cctpPaymentMaxPlatformFeeBps: null,
    permitMode: 'approve',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    tokenMessenger: CCTP_V2_MAINNET_TOKEN_MESSENGER,
  },
  43114: {
    chainId: 43114,
    name: 'Avalanche',
    isTestnet: false,
    isHomeChain: false,
    settlementChainId: 42161,
    cctpDomain: 1,
    paymentSource: false,
    cctpStandard: true,
    cctpFast: false,
    localPaymentRouter: null,
    cctpPaymentRouter: null,
    localPaymentMaxPlatformFeeBps: null,
    cctpPaymentMaxPlatformFeeBps: null,
    permitMode: 'approve',
    usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    tokenMessenger: CCTP_V2_MAINNET_TOKEN_MESSENGER,
  },
};

export function getPaymentNetworkCapabilities(chainId: number): PaymentNetworkCapabilities | null {
  return PAYMENT_NETWORKS[chainId] ?? null;
}
