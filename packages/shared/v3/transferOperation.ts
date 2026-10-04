import { paymasterFields, maximumOperationGasCost, type PaymasterTerms } from './paymaster';
import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { authorizationDigest, type ExecutionPlan } from './authorizations';
import { evmChainId, parseAtomicAmount } from './primitives';
import { compileTransferCalls } from './transferCalls';
import type { TransferRequest } from './transfer';

type GasTerms = {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

/** Internal unsigned candidate for an activated, deployed Account V3 and the
 * admitted EntryPoint v0.9 profile. This compiler does not establish admission,
 * ownership, active policy, nonce availability, funding or token semantics.
 * Rebuild independently on client/server before consent. No provider or signer.
 */
export function prepareTransferOperation(
  request: TransferRequest,
  context: Parameters<typeof compileTransferCalls>[1] & {
    account_id: Hex;
    deployment_digest: Hex;
    policy_hash: Hex;
    entry_point: Address;
    nonce: bigint;
    gas: GasTerms;
    sponsorship?: PaymasterTerms;
    checkpoint: { block_number: string; block_hash: Hex; observed_at: number; expires_at: number };
    valid_until: number;
  },
  now: number,
) {
  const compiled = compileTransferCalls(request, context);
  const chainId = evmChainId(compiled.request.network_id);
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Unsupported transfer chain identifier');
  for (const hash of [
    context.account_id,
    context.deployment_digest,
    context.policy_hash,
    context.checkpoint.block_hash,
  ]) {
    if (!/^0x[0-9a-f]{64}$(?![\s\S])/.test(hash) || hash === zeroHash)
      throw new Error('Invalid transfer context hash');
  }
  if (
    !isAddress(context.entry_point, { strict: true }) ||
    context.entry_point.toLowerCase() === zeroAddress ||
    context.entry_point.toLowerCase() === compiled.account.toLowerCase()
  )
    throw new Error('Invalid transfer EntryPoint');
  const entryPoint = getAddress(context.entry_point);
  if (typeof context.nonce !== 'bigint' || context.nonce < 0n || context.nonce >= 1n << 64n)
    throw new Error('Unsupported transfer nonce key');
  const checkpoint = { ...context.checkpoint };
  const block = BigInt(parseAtomicAmount(checkpoint.block_number));
  if (
    ![now, checkpoint.observed_at, checkpoint.expires_at, context.valid_until].every(
      Number.isSafeInteger,
    ) ||
    now < 1 ||
    checkpoint.observed_at < 1 ||
    checkpoint.observed_at > now ||
    checkpoint.expires_at <= now ||
    checkpoint.expires_at > checkpoint.observed_at + 60 ||
    context.valid_until <= now ||
    context.valid_until > checkpoint.expires_at ||
    context.valid_until > 0x7fffffffffff
  )
    throw new Error('Transfer observation/window expired or invalid');
  const gas = { ...context.gas };
  for (const key of [
    'verificationGasLimit',
    'callGasLimit',
    'preVerificationGas',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
  ] as const) {
    if (
      typeof gas[key] !== 'bigint' ||
      gas[key] < 0n ||
      gas[key] >= 1n << 120n ||
      (key !== 'maxPriorityFeePerGas' && gas[key] === 0n)
    )
      throw new Error('Invalid transfer gas terms');
  }
  if (gas.maxPriorityFeePerGas > gas.maxFeePerGas) throw new Error('Invalid transfer priority fee');
  const sponsored = paymasterFields(context.sponsorship, {
    validAfter: now,
    validUntil: context.valid_until,
  });
  const maximumEntryPointCharge = maximumOperationGasCost({ ...gas, ...sponsored });
  const maximumAccountGas = BigInt(context.budget.maximum_native_gas_atomic);
  if (context.sponsorship ? maximumAccountGas !== 0n : maximumEntryPointCharge > maximumAccountGas)
    throw new Error('Transfer exceeds reserved gas budget');
  // Sponsorship is part of the exact operation before user consent.
  const operation: UserOperation<'0.9'> = Object.freeze({
    sender: compiled.account,
    nonce: context.nonce,
    callData: compiled.calldata,
    verificationGasLimit: gas.verificationGasLimit,
    callGasLimit: gas.callGasLimit,
    preVerificationGas: gas.preVerificationGas,
    maxFeePerGas: gas.maxFeePerGas,
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    signature: '0x',
    ...sponsored,
  });
  const userOpHash = getUserOperationHash({
    chainId: Number(chainId),
    entryPointAddress: entryPoint,
    entryPointVersion: '0.9',
    userOperation: operation,
  });
  const hash = (value: string) => keccak256(stringToHex(value));
  const assetLimitsHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        hash('GatoPagoV3TransferAssetLimits:1'),
        hash(compiled.request.asset_id),
        BigInt(compiled.funding.amount_atomic),
        BigInt(compiled.funding.asset_debit_atomic),
        maximumAccountGas,
      ],
    ),
  );
  const feePolicyHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        hash('GatoPagoV3TransferFees:1'),
        hash(context.budget.platform_fee.asset_id),
        BigInt(context.budget.platform_fee.amount_atomic),
        context.fee_recipient ?? zeroAddress,
        maximumEntryPointCharge,
        maximumAccountGas,
      ],
    ),
  );
  const previewHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint48' },
        { type: 'uint48' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        hash('GatoPagoV3TransferPreview:1'),
        hash(compiled.request.wallet_id),
        context.deployment_digest,
        hash(compiled.request.client_release_id),
        hash(compiled.request.amount.kind),
        hash(compiled.request.destination.address_type),
        hash(context.native_asset_id),
        checkpoint.block_hash,
        block,
        BigInt(context.budget.asset_available_atomic),
        BigInt(context.budget.native_available_atomic),
        checkpoint.observed_at,
        checkpoint.expires_at,
        assetLimitsHash,
        feePolicyHash,
        context.policy_hash,
      ],
    ),
  );
  const plan: ExecutionPlan = Object.freeze({
    accountId: context.account_id,
    generation: 3,
    securityVersion: context.security_version,
    executionMode: 0,
    entryPoint,
    userOpHash,
    callsHash: compiled.calls_hash,
    assetLimitsHash,
    feePolicyHash,
    paymaster: operation.paymaster ?? zeroAddress,
    previewHash,
    nonce: context.nonce,
    validAfter: now,
    validUntil: context.valid_until,
  });
  const digest = authorizationDigest('ExecutionPlan', chainId, compiled.account, plan);
  Object.freeze(compiled.request.amount);
  Object.freeze(compiled.request.destination);
  Object.freeze(compiled.request);
  compiled.calls.forEach(Object.freeze);
  return Object.freeze({
    request: compiled.request,
    account: compiled.account,
    deployment_digest: context.deployment_digest,
    policy_hash: context.policy_hash,
    funding: Object.freeze(compiled.funding),
    calls: Object.freeze(compiled.calls),
    checkpoint: Object.freeze(checkpoint),
    operation,
    plan,
    digest,
    userOpHash,
    maximumEntryPointCharge,
  });
}
