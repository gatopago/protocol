import {
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseSignature,
  type Address,
  type Client,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import { readContract } from 'viem/actions';
import type { WalletNetwork } from './networks';

/** `GatoPagoPaymentRouter` (contracts/src): pays a Flow payment intent as Flow authorized it. */
export const paymentRouterAbi = parseAbi([
  'struct Payment { bytes32 intentId; address payer; address merchant; address token; uint256 amount; uint256 fee; uint32 destinationDomain; uint256 maxCctpFee; uint32 minFinalityThreshold; uint48 validUntil; }',
  'function pay(Payment payment, bytes signature)',
  'function payWithPermit(Payment payment, bytes signature, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function paid(bytes32 intentId) view returns (bool)',
  'event PaymentSent(bytes32 indexed intentId, address indexed payer, address indexed merchant, address token, uint256 amount, uint256 fee, uint32 destinationDomain)',
]);

export type Payment = {
  readonly intentId: Hex;
  readonly payer: Address;
  readonly merchant: Address;
  /** The coin it is paid in, fee included: USDC, or another coin of the network (AUSD). */
  readonly token: Address;
  /** What the merchant receives. */
  readonly amount: bigint;
  /** Platform fee, paid by the payer. */
  readonly fee: bigint;
  /**
   * Circle domain where the merchant receives; the paying network's own domain pays locally. Only
   * USDC crosses networks.
   */
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
      version: '4',
      chainId: network.chain.id,
      verifyingContract: network.paymentRouter,
    },
    types: {
      Payment: [
        { name: 'intentId', type: 'bytes32' },
        { name: 'payer', type: 'address' },
        { name: 'merchant', type: 'address' },
        { name: 'token', type: 'address' },
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

/** What the payer spends of the payment's token on `network`. */
export function paymentTotal(network: WalletNetwork, payment: Payment): bigint {
  const crossing = payment.destinationDomain !== network.cctp.domain;
  return payment.amount + payment.fee + (crossing ? payment.maxCctpFee : 0n);
}

/** Calls a smart account sends as one operation: approve the router, then pay. */
export function paymentCalls(network: WalletNetwork, payment: Payment, signature: Hex) {
  return [
    {
      to: payment.token,
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

const permitAbi = parseAbi([
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function nonces(address owner) view returns (uint256)',
]);

/**
 * A token's EIP-712 domain: the one it declares (ERC-5267) when it does, as AUSD ("Agora Dollar",
 * though its `name()` is "AUSD"); otherwise its name and version, as Circle's USDC.
 */
async function permitDomain(client: Client, network: WalletNetwork, token: Address) {
  const declared = await readContract(client, {
    address: token,
    abi: permitAbi,
    functionName: 'eip712Domain',
  }).catch(() => null);
  if (declared) {
    const [, name, version, chainId, verifyingContract] = declared;
    return { name, version, chainId: Number(chainId), verifyingContract };
  }
  const [name, version] = await Promise.all([
    readContract(client, { address: token, abi: permitAbi, functionName: 'name' }),
    readContract(client, { address: token, abi: permitAbi, functionName: 'version' }),
  ]);
  return { name, version, chainId: network.chain.id, verifyingContract: token };
}

/**
 * The EIP-2612 permit a browser wallet signs (no gas) so the router takes exactly `value` of
 * `token` in the same transaction as the payment (`payWithPermitCall`): one transaction instead of
 * an approve and a payment, and no allowance left behind. Circle's USDC and Agora's AUSD support it;
 * the token's EIP-712 domain and the owner's nonce are read from it.
 */
export async function paymentPermit(
  client: Client,
  network: WalletNetwork,
  permit: { token: Address; owner: Address; value: bigint; deadline: bigint },
) {
  const [domain, nonce] = await Promise.all([
    permitDomain(client, network, permit.token),
    readContract(client, {
      address: permit.token,
      abi: permitAbi,
      functionName: 'nonces',
      args: [permit.owner],
    }),
  ]);
  return {
    domain,
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: {
      owner: permit.owner,
      spender: network.paymentRouter,
      value: permit.value,
      nonce,
      deadline: permit.deadline,
    },
  } as const satisfies TypedDataDefinition;
}

/** The router call that spends a signed `paymentPermit` and pays in one transaction. */
export function payWithPermitCall(
  network: WalletNetwork,
  payment: Payment,
  signature: Hex,
  permit: { deadline: bigint; signature: Hex },
) {
  const { r, s, yParity } = parseSignature(permit.signature);
  return {
    to: network.paymentRouter,
    data: encodeFunctionData({
      abi: paymentRouterAbi,
      functionName: 'payWithPermit',
      args: [payment, signature, permit.deadline, 27 + yParity, r, s],
    }),
  };
}
