import {
  encodeFunctionData,
  erc20Abi,
  pad,
  parseAbi,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import type { WalletNetwork } from './networks';

const tokenMessengerAbi = parseAbi([
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
]);

/** Asks Circle's Forwarding Service to mint on the destination network: no relayer of ours. */
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000';
const FAST = 1000;
const STANDARD = 2000;

const iris = (network: WalletNetwork) =>
  network.chain.testnet ? 'https://iris-api-sandbox.circle.com' : 'https://iris-api.circle.com';
const finality = (network: WalletNetwork) => (network.cctp.fast ? FAST : STANDARD);

/**
 * Most USDC that moving `amount` from `from` to `to` can cost: Circle's CCTP fee plus the
 * Forwarding Service fee (destination gas), both taken from the transferred USDC.
 */
export async function crosschainFee(
  from: WalletNetwork,
  to: WalletNetwork,
  amount: bigint,
  signal?: AbortSignal,
): Promise<bigint> {
  const response = await fetch(
    `${iris(from)}/v2/burn/USDC/fees/${from.cctp.domain}/${to.cctp.domain}?forward=true`,
    { signal },
  );
  if (!response.ok) throw new Error(`CCTP_FEE_UNAVAILABLE: ${response.status}`);
  const fees: { finalityThreshold: number; minimumFee: number; forwardFee: { high: number } }[] =
    await response.json();
  const fee = fees.find((value) => value.finalityThreshold === finality(from));
  if (!fee) throw new Error('CCTP_FEE_UNAVAILABLE');
  // `minimumFee` is in basis points, possibly fractional (e.g. 1.3).
  const protocolFee = (amount * BigInt(Math.ceil(fee.minimumFee * 100)) + 999_999n) / 1_000_000n;
  return protocolFee + BigInt(fee.forwardFee.high);
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
  if (maxFee >= amount) throw new Error('CCTP_AMOUNT_BELOW_FEE');
  return [
    {
      to: from.usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [from.cctp.tokenMessenger, amount],
      }),
    },
    {
      to: from.cctp.tokenMessenger,
      data: encodeFunctionData({
        abi: tokenMessengerAbi,
        functionName: 'depositForBurnWithHook',
        args: [
          amount,
          to.cctp.domain,
          pad(recipient),
          from.usdc,
          zeroHash,
          maxFee,
          finality(from),
          FORWARD_HOOK,
        ],
      }),
    },
  ];
}

/** Where a crossing stands: burned on the source, attested by Circle, minted on the destination. */
export type CrosschainStage = 'burned' | 'attested' | 'delivered' | 'failed';

/**
 * The stage of the crossing burned by `transactionHash` on `from`, as Circle's Iris API reports
 * it, and the destination mint transaction once the Forwarding Service sent it.
 */
export async function crosschainStatus(
  from: WalletNetwork,
  transactionHash: Hex,
  signal?: AbortSignal,
): Promise<{ stage: CrosschainStage; forwardTxHash: Hex | null }> {
  const response = await fetch(
    `${iris(from)}/v2/messages/${from.cctp.domain}?transactionHash=${transactionHash}`,
    { signal },
  );
  // Iris answers 404 until it sees the burn.
  if (response.status === 404) return { stage: 'burned', forwardTxHash: null };
  if (!response.ok) throw new Error(`CCTP_STATUS_UNAVAILABLE: ${response.status}`);
  const { messages } = (await response.json()) as {
    messages?: { status?: string; forwardState?: string; forwardTxHash?: Hex }[];
  };
  const message = messages?.[0];
  const forwardTxHash = message?.forwardTxHash ?? null;
  if (message?.forwardState === 'FAILED') return { stage: 'failed', forwardTxHash };
  if (message?.forwardState === 'COMPLETE' && forwardTxHash)
    return { stage: 'delivered', forwardTxHash };
  return { stage: message?.status === 'complete' ? 'attested' : 'burned', forwardTxHash };
}
