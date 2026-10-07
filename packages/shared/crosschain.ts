import {
  encodeFunctionData,
  erc20Abi,
  pad,
  parseAbi,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import type { StellarNetwork, WalletNetwork } from './networks';

const tokenMessengerAbi = parseAbi([
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
]);

/** Asks Circle's Forwarding Service to mint on the destination network: no relayer of ours. */
export const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000';
const FAST = 1000;
const STANDARD = 2000;

/** A network Circle CCTP reaches: an EVM wallet network or Stellar. */
export type CctpNetwork = WalletNetwork | StellarNetwork;

const testnet = (network: CctpNetwork) =>
  'chain' in network ? !!network.chain.testnet : network.testnet;
const iris = (network: CctpNetwork) =>
  testnet(network) ? 'https://iris-api-sandbox.circle.com' : 'https://iris-api.circle.com';
/** Finality threshold of burns on `network`. */
export const finality = (network: CctpNetwork) => (network.cctp.fast ? FAST : STANDARD);
/** Circle's Forwarding Service mints on EVM destinations; on Stellar our relayer does. */
const forwarded = (network: CctpNetwork) => 'chain' in network;

/**
 * Most USDC that moving `amount` from `from` to `to` can cost: Circle's CCTP fee plus, toward an EVM
 * network, the Forwarding Service fee (destination gas), both taken from the transferred USDC.
 * Amounts in CCTP's 6 decimals, also from Stellar.
 */
export async function crosschainFee(
  from: CctpNetwork,
  to: CctpNetwork,
  amount: bigint,
  signal?: AbortSignal,
): Promise<bigint> {
  const response = await fetch(
    `${iris(from)}/v2/burn/USDC/fees/${from.cctp.domain}/${to.cctp.domain}${forwarded(to) ? '?forward=true' : ''}`,
    { signal },
  );
  if (!response.ok) throw new Error(`CCTP_FEE_UNAVAILABLE: ${response.status}`);
  const fees: { finalityThreshold: number; minimumFee: number; forwardFee?: { high: number } }[] =
    await response.json();
  const fee = fees.find((value) => value.finalityThreshold === finality(from));
  if (!fee || (forwarded(to) && !fee.forwardFee)) throw new Error('CCTP_FEE_UNAVAILABLE');
  // `minimumFee` is in basis points, possibly fractional (e.g. 1.3).
  const protocolFee = (amount * BigInt(Math.ceil(fee.minimumFee * 100)) + 999_999n) / 1_000_000n;
  return protocolFee + (forwarded(to) && fee.forwardFee ? BigInt(fee.forwardFee.high) : 0n);
}

/**
 * Calls that burn `amount` USDC on `from` so that `recipient` receives it on `to`, minus at most
 * `maxFee`. The account sends them as one operation; Circle mints on the destination.
 */
export function crosschainCalls(parameters: {
  from: WalletNetwork;
  to: WalletNetwork;
  amount: bigint;
  recipient: Address;
  maxFee: bigint;
}): { to: Address; data: Hex }[] {
  const { from, to, amount, recipient, maxFee } = parameters;
  return burnCalls(from, {
    domain: to.cctp.domain,
    mintRecipient: pad(recipient),
    destinationCaller: zeroHash,
    hookData: FORWARD_HOOK,
    amount,
    maxFee,
  });
}

/** `approve` and `depositForBurnWithHook` on an EVM network, toward any CCTP domain. */
export function burnCalls(
  from: WalletNetwork,
  burn: {
    domain: number;
    mintRecipient: Hex;
    destinationCaller: Hex;
    hookData: Hex;
    amount: bigint;
    maxFee: bigint;
  },
): { to: Address; data: Hex }[] {
  if (burn.maxFee >= burn.amount) throw new Error('CCTP_AMOUNT_BELOW_FEE');
  return [
    {
      to: from.usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [from.cctp.tokenMessenger, burn.amount],
      }),
    },
    {
      to: from.cctp.tokenMessenger,
      data: encodeFunctionData({
        abi: tokenMessengerAbi,
        functionName: 'depositForBurnWithHook',
        args: [
          burn.amount,
          burn.domain,
          burn.mintRecipient,
          from.usdc,
          burn.destinationCaller,
          burn.maxFee,
          finality(from),
          burn.hookData,
        ],
      }),
    },
  ];
}

/** Where a crossing stands: burned on the source, attested by Circle, minted on the destination. */
export type CrosschainStage = 'burned' | 'attested' | 'delivered' | 'failed';

/** What `crosschainStatus` learns about a crossing. */
export interface CrosschainStatus {
  readonly stage: CrosschainStage;
  /** The destination mint, once the Forwarding Service sent it. */
  readonly forwardTxHash: Hex | null;
  /** The attested message, which anyone can mint with when nobody forwards it (to Stellar). */
  readonly attested: { readonly message: Hex; readonly attestation: Hex } | null;
}

/** The stage of the crossing burned by `transactionHash` on `from`, as Circle's Iris API reports it. */
export async function crosschainStatus(
  from: CctpNetwork,
  transactionHash: string,
  signal?: AbortSignal,
): Promise<CrosschainStatus> {
  const response = await fetch(
    `${iris(from)}/v2/messages/${from.cctp.domain}?transactionHash=${transactionHash}`,
    { signal },
  );
  // Iris answers 404 until it sees the burn.
  if (response.status === 404) return { stage: 'burned', forwardTxHash: null, attested: null };
  if (!response.ok) throw new Error(`CCTP_STATUS_UNAVAILABLE: ${response.status}`);
  const { messages } = (await response.json()) as {
    messages?: {
      status?: string;
      message?: Hex;
      attestation?: Hex;
      forwardState?: string;
      forwardTxHash?: Hex;
    }[];
  };
  const message = messages?.[0];
  const forwardTxHash = message?.forwardTxHash ?? null;
  const attested =
    message?.status === 'complete' && message.message && message.attestation
      ? { message: message.message, attestation: message.attestation }
      : null;
  if (message?.forwardState === 'FAILED') return { stage: 'failed', forwardTxHash, attested };
  // Circle reports the mint as CONFIRMED (seen from Stellar, it stays there) or COMPLETE.
  if (
    (message?.forwardState === 'CONFIRMED' || message?.forwardState === 'COMPLETE') &&
    forwardTxHash
  )
    return { stage: 'delivered', forwardTxHash, attested };
  return { stage: attested ? 'attested' : 'burned', forwardTxHash, attested };
}
