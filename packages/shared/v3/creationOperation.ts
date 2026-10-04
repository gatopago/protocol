import { paymasterFields, maximumOperationGasCost, type PaymasterTerms } from './paymaster';
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  stringToHex,
  zeroAddress,
  zeroHash,
} from 'viem';
import {
  getUserOperationHash,
  toPackedUserOperation,
  type UserOperation,
} from 'viem/account-abstraction';
import { authorizationDigest, type ExecutionPlan } from './authorizations';
import { encodeExecutionSignature, executionAbi } from './execution';
import {
  authorizeInitialization,
  prepareInitialization,
  type InitializationInput,
} from './initialization';
import { encodeWebAuthnAssertion, type WebAuthnAssertionBytes } from './webauthn';

export interface CreationGasTerms {
  readonly verificationGasLimit: bigint;
  readonly callGasLimit: bigint;
  readonly preVerificationGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  /** Explicit user-approved upper bound for EntryPoint charges, in native atomic units.
   * Not a fee quote, a commercial GatoPago fee, or a guarantee covering every L2 surcharge. */
  readonly maximumGasCharge: bigint;
  readonly sponsorship?: PaymasterTerms;
}

/** Internal creation path for the pinned ERC4337/domain-version-1
 * EntryPoint profile. Compiles admitted sponsorship terms; no provider I/O or funding decision.
 * The only call is completeCreation(); no asset transfer, approval or arbitrary calldata.
 * Recompute on BOTH client and server before the separate operation-signing gesture.
 */
export function prepareCreationOperation(
  input: InitializationInput,
  initialProof: WebAuthnAssertionBytes,
  terms: CreationGasTerms,
  now: number,
) {
  const prepared = prepareInitialization(input);
  const initial = authorizeInitialization(input, initialProof, now);
  const gas = Object.freeze({ ...terms });
  // EntryPoint rejects gas values over 120 bits; do not silently truncate or coerce numbers.
  for (const field of [
    'verificationGasLimit',
    'callGasLimit',
    'preVerificationGas',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
  ] as const) {
    if (
      typeof gas[field] !== 'bigint' ||
      gas[field] < 0n ||
      gas[field] >= 1n << 120n ||
      (field !== 'maxPriorityFeePerGas' && gas[field] === 0n)
    )
      throw new Error('Invalid creation gas terms');
  }
  if (
    gas.maxPriorityFeePerGas > gas.maxFeePerGas ||
    typeof gas.maximumGasCharge !== 'bigint' ||
    gas.maximumGasCharge <= 0n ||
    gas.maximumGasCharge >= 1n << 256n
  )
    throw new Error('Invalid creation gas cap');
  const sponsored = paymasterFields(gas.sponsorship, prepared.message);
  const maximumEntryPointCharge = maximumOperationGasCost({ ...gas, ...sponsored });
  if (maximumEntryPointCharge > gas.maximumGasCharge)
    throw new Error('Creation exceeds approved gas cap');
  if (prepared.chainId > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Unsupported creation chain identifier');
  const operation: UserOperation<'0.9'> = Object.freeze({
    sender: prepared.account,
    nonce: 0n,
    factory: initial.factory,
    factoryData: initial.factoryData,
    callData: encodeFunctionData({ abi: executionAbi, functionName: 'completeCreation' }),
    verificationGasLimit: gas.verificationGasLimit,
    callGasLimit: gas.callGasLimit,
    preVerificationGas: gas.preVerificationGas,
    maxFeePerGas: gas.maxFeePerGas,
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    signature: '0x',
    ...sponsored,
  });
  const userOpHash = getUserOperationHash({
    chainId: Number(prepared.chainId),
    entryPointAddress: prepared.message.entryPoint,
    entryPointVersion: '0.9',
    userOperation: operation,
  });
  const feePolicyHash = keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [maximumEntryPointCharge, gas.maximumGasCharge],
    ),
  );
  const previewHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        keccak256(stringToHex('GatoPagoV3CreationPreview')),
        prepared.digest,
        prepared.profileDigest,
        prepared.account,
        gas.maximumGasCharge,
      ],
    ),
  );
  const plan: ExecutionPlan = Object.freeze({
    accountId: prepared.message.accountId,
    generation: 3,
    securityVersion: 1n,
    executionMode: 0,
    entryPoint: prepared.message.entryPoint,
    userOpHash,
    callsHash: keccak256(operation.callData),
    assetLimitsHash: zeroHash,
    feePolicyHash,
    paymaster: operation.paymaster ?? zeroAddress,
    previewHash,
    nonce: 0n,
    validAfter: prepared.message.validAfter,
    validUntil: prepared.message.validUntil,
  });
  const digest = authorizationDigest('ExecutionPlan', prepared.chainId, prepared.account, plan);
  return Object.freeze({ prepared, operation, userOpHash, plan, digest, maximumEntryPointCharge });
}

/** Verifies both distinct authorizations. Acceptance is not broadcast, creation, recovery
 * activation or spend readiness. Never mutate/reprice the returned operation after signing. */
export function authorizeCreationOperation(
  input: InitializationInput,
  initialProof: WebAuthnAssertionBytes,
  terms: CreationGasTerms,
  operationProof: WebAuthnAssertionBytes,
  now: number,
) {
  const candidate = prepareCreationOperation(input, initialProof, terms, now);
  const signature = encodeWebAuthnAssertion({
    scope: candidate.prepared.scope,
    key: input.publicKey,
    challenge: candidate.digest,
    response: operationProof,
  });
  const operation = Object.freeze({
    ...candidate.operation,
    signature: encodeExecutionSignature(candidate.plan, [{ signerIndex: 0, signature }]),
  });
  return Object.freeze({
    ...candidate,
    operation,
    packed: Object.freeze(toPackedUserOperation(operation)),
  });
}
