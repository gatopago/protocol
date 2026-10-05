import {
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import type { WalletNetwork } from './networks';

/** `GatoPagoPaymentRouter` (contracts/src): pays a Flow payment intent as Flow authorized it. */
export const paymentRouterAbi = parseAbi([
  'struct Payment { bytes32 intentId; address payer; address merchant; uint256 amount; uint256 fee; uint32 destinationDomain; uint256 maxCctpFee; uint32 minFinalityThreshold; uint48 validUntil; }',
  'function pay(Payment payment, bytes signature)',
  'function payWithPermit(Payment payment, bytes signature, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function paid(bytes32 intentId) view returns (bool)',
  'event PaymentSent(bytes32 indexed intentId, address indexed payer, address indexed merchant, uint256 amount, uint256 fee, uint32 destinationDomain)',
]);

export type Payment = {
  readonly intentId: Hex;
  readonly payer: Address;
  readonly merchant: Address;
  /** What the merchant receives. */
  readonly amount: bigint;
  /** Platform fee, paid by the payer. */
  readonly fee: bigint;
  /** Circle domain where the merchant receives; the paying network's own domain pays locally. */
  readonly destinationDomain: number;
  /** Ceiling of Circle's fee when crossing networks, paid by the payer. */
  readonly maxCctpFee: bigint;
  readonly minFinalityThreshold: number;
  readonly validUntil: number;
};

/** The authorization Flow's signer signs (EIP-712), for the router on `network`. */
export function paymentTypedData(network: WalletNetwork, payment: Payment) {
  return {
    domain: {
      name: 'GatoPago Payment Router',
      version: '3',
      chainId: network.chain.id,
      verifyingContract: network.paymentRouter,
    },
    types: {
      Payment: [
        { name: 'intentId', type: 'bytes32' },
        { name: 'payer', type: 'address' },
        { name: 'merchant', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'fee', type: 'uint256' },
        { name: 'destinationDomain', type: 'uint32' },
        { name: 'maxCctpFee', type: 'uint256' },
        { name: 'minFinalityThreshold', type: 'uint32' },
        { name: 'validUntil', type: 'uint48' },
      ],
    },
    primaryType: 'Payment',
    message: payment,
  } as const satisfies TypedDataDefinition;
}

/** USDC the payer spends on `network`. */
export function paymentTotal(network: WalletNetwork, payment: Payment): bigint {
  const crossing = payment.destinationDomain !== network.cctp.domain;
  return payment.amount + payment.fee + (crossing ? payment.maxCctpFee : 0n);
}

/** Calls a smart account sends as one operation: approve the router, then pay. */
export function paymentCalls(network: WalletNetwork, payment: Payment, signature: Hex) {
  return [
    {
      to: network.usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [network.paymentRouter, paymentTotal(network, payment)],
      }),
    },
    {
      to: network.paymentRouter,
      data: encodeFunctionData({
        abi: paymentRouterAbi,
        functionName: 'pay',
        args: [payment, signature],
      }),
    },
  ];
}
