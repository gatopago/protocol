import {
  encodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  slice,
  zeroAddress,
  type Hex,
} from 'viem';
import { toPackedUserOperation, type UserOperation } from 'viem/account-abstraction';
import { parseAtomicAmount } from './primitives';

export interface PaymasterTerms {
  readonly address: Hex;
  readonly verificationGasLimit: string;
  readonly postOpGasLimit: string;
  readonly data: Hex;
}

export function parsePaymasterTerms(value: unknown): PaymasterTerms {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'address,data,postOpGasLimit,verificationGasLimit'
  )
    throw new Error('PAYMASTER_TERMS_INVALID');
  const r = value as Record<string, unknown>;
  if (
    typeof r.address !== 'string' ||
    getAddress(r.address) === zeroAddress ||
    typeof r.data !== 'string' ||
    !/^0x[0-9a-f]{154}$(?![\s\S])/.test(r.data)
  )
    throw new Error('PAYMASTER_TERMS_INVALID');
  const verification = parseAtomicAmount(r.verificationGasLimit),
    postOp = parseAtomicAmount(r.postOpGasLimit);
  if (
    BigInt(verification) === 0n ||
    BigInt(verification) >= 1n << 120n ||
    BigInt(postOp) >= 1n << 120n
  )
    throw new Error('PAYMASTER_TERMS_INVALID');
  return Object.freeze({
    address: getAddress(r.address),
    verificationGasLimit: verification,
    postOpGasLimit: postOp,
    data: r.data as Hex,
  });
}

export function paymasterFields(
  input?: PaymasterTerms,
  window?: { validAfter: number; validUntil: number },
) {
  if (!input) return {};
  const p = parsePaymasterTerms(input),
    after = BigInt(slice(p.data, 0, 6)),
    until = BigInt(slice(p.data, 6, 12));
  if (
    after >= until ||
    until > 0x7fffffffffffn ||
    (window && (after > BigInt(window.validAfter) || until < BigInt(window.validUntil)))
  ) {
    throw new Error('PAYMASTER_WINDOW_INVALID');
  }
  return {
    paymaster: p.address,
    paymasterVerificationGasLimit: BigInt(p.verificationGasLimit),
    paymasterPostOpGasLimit: BigInt(p.postOpGasLimit),
    paymasterData: p.data,
  };
}

export function maximumOperationGasCost(
  operation: Pick<
    UserOperation<'0.9'>,
    'verificationGasLimit' | 'callGasLimit' | 'preVerificationGas' | 'maxFeePerGas'
  > &
    Partial<
      Pick<UserOperation<'0.9'>, 'paymasterVerificationGasLimit' | 'paymasterPostOpGasLimit'>
    >,
) {
  return (
    (operation.verificationGasLimit +
      operation.callGasLimit +
      operation.preVerificationGas +
      (operation.paymasterVerificationGasLimit ?? 0n) +
      (operation.paymasterPostOpGasLimit ?? 0n)) *
    operation.maxFeePerGas
  );
}

export function paymasterSponsorDigest(chainId: bigint, operation: UserOperation<'0.9'>) {
  if (!operation.paymaster || !operation.paymasterData) throw new Error('PAYMASTER_REQUIRED');
  const packed = toPackedUserOperation(operation),
    data = operation.paymasterData;
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        chainId,
        operation.paymaster,
        operation.sender,
        operation.nonce,
        keccak256(packed.initCode),
        keccak256(operation.callData),
        packed.accountGasLimits,
        operation.preVerificationGas,
        packed.gasFees,
        keccak256(slice(packed.paymasterAndData, 0, 52)),
        BigInt(slice(data, 0, 6)),
        BigInt(slice(data, 6, 12)),
      ],
    ),
  );
}

export function sponsorshipData(validAfter: number, validUntil: number, signature: Hex): Hex {
  return encodePacked(['uint48', 'uint48', 'bytes'], [validAfter, validUntil, signature]);
}
