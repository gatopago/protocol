import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { authorizationDigest, type ExecutionPlan } from './authorizations';
import { maximumOperationGasCost } from './paymaster';
import { requireHash } from './deployment';
import { parseAtomicAmount, type ResourceId } from './primitives';
import { compileMoneyCalls } from './moneyCalls';
import { moneyAddress, moneyFields, moneyInteger, type MoneyOperationRequest } from './moneyWire';
import type { AaveMarketPin } from './aaveMarket';

export interface MoneyOperationContext {
  account: Address;
  wallet_account_id: ResourceId<'walletAccount'>;
  account_id: Hex;
  deployment_digest: Hex;
  policy_hash: Hex;
  security_version: bigint;
  entry_point: Address;
  nonce: bigint;
  market: AaveMarketPin;
  native_asset_id: 'eip155:421614/slip44:60';
  gas: {
    verificationGasLimit: bigint;
    callGasLimit: bigint;
    preVerificationGas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  };
  budget: {
    usdc_available_atomic: string;
    position_available_atomic: string;
    native_available_atomic: string;
    maximum_native_gas_atomic: string;
    debt_base_atomic: string;
    liquidity_atomic: string;
    supply_capacity_atomic: string | null;
  };
  checkpoint: { block_number: string; block_hash: Hex; observed_at: number; expires_at: number };
  valid_until: number;
}

export function prepareMoneyOperation(
  input: MoneyOperationRequest,
  contextInput: MoneyOperationContext,
  now: number,
) {
  const context = structuredClone(contextInput);
  moneyFields(context, [
    'account',
    'wallet_account_id',
    'account_id',
    'deployment_digest',
    'policy_hash',
    'security_version',
    'entry_point',
    'nonce',
    'market',
    'native_asset_id',
    'gas',
    'budget',
    'checkpoint',
    'valid_until',
  ]);
  moneyFields(context.gas, [
    'verificationGasLimit',
    'callGasLimit',
    'preVerificationGas',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
  ]);
  moneyFields(context.budget, [
    'usdc_available_atomic',
    'position_available_atomic',
    'native_available_atomic',
    'maximum_native_gas_atomic',
    'debt_base_atomic',
    'liquidity_atomic',
    'supply_capacity_atomic',
  ]);
  moneyFields(context.checkpoint, ['block_number', 'block_hash', 'observed_at', 'expires_at']);
  moneyFields(context.market, ['document', 'digest']);
  const compiled = compileMoneyCalls(input, context),
    request = compiled.request;
  for (const hash of [
    context.account_id,
    context.deployment_digest,
    context.policy_hash,
    context.checkpoint.block_hash,
  ])
    requireHash(hash);
  if (
    request.wallet_account_id !== context.wallet_account_id ||
    context.native_asset_id !== 'eip155:421614/slip44:60'
  )
    throw new Error('MONEY_ACCOUNT_MISMATCH');
  const entryPoint = moneyAddress(context.entry_point);
  if (entryPoint === getAddress(context.account) || entryPoint === compiled.market.pool)
    throw new Error('MONEY_ENTRYPOINT_INVALID');
  if (
    typeof context.nonce !== 'bigint' ||
    context.nonce < 0n ||
    context.nonce >= 1n << 64n ||
    typeof context.security_version !== 'bigint' ||
    context.security_version < 1n ||
    context.security_version >= 1n << 64n
  )
    throw new Error('MONEY_NONCE_OR_VERSION_INVALID');
  for (const value of [
    now,
    context.checkpoint.observed_at,
    context.checkpoint.expires_at,
    context.valid_until,
  ])
    moneyInteger(value);
  const block = BigInt(parseAtomicAmount(context.checkpoint.block_number));
  if (
    context.checkpoint.observed_at > now ||
    now >= context.checkpoint.expires_at ||
    context.checkpoint.expires_at >
      context.checkpoint.observed_at + compiled.market.max_observation_age_seconds ||
    now >= context.valid_until ||
    context.valid_until > context.checkpoint.expires_at ||
    context.valid_until > 0x7fffffffffff ||
    now < compiled.market.valid_from ||
    context.valid_until > compiled.market.valid_until ||
    block < BigInt(compiled.market.admitted_block_number) ||
    (block === BigInt(compiled.market.admitted_block_number) &&
      context.checkpoint.block_hash !== compiled.market.admitted_block_hash)
  ) {
    throw new Error('MONEY_OBSERVATION_EXPIRED');
  }
  for (const [key, amount] of Object.entries(context.gas)) {
    if (
      typeof amount !== 'bigint' ||
      amount < 0n ||
      amount >= 1n << 120n ||
      (key !== 'maxPriorityFeePerGas' && amount === 0n)
    )
      throw new Error('MONEY_GAS_INVALID');
  }
  if (context.gas.maxPriorityFeePerGas > context.gas.maxFeePerGas)
    throw new Error('MONEY_GAS_INVALID');
  for (const [key, value] of Object.entries(context.budget))
    if (key !== 'supply_capacity_atomic' || value !== null) parseAtomicAmount(value);
  const budget = context.budget,
    amount = BigInt(request.amount_atomic);
  const maximumCharge = maximumOperationGasCost(context.gas),
    gasReserve = BigInt(budget.maximum_native_gas_atomic);
  if (budget.debt_base_atomic !== '0') throw new Error('MONEY_DEBT_NOT_SUPPORTED');
  if (maximumCharge > gasReserve || gasReserve > BigInt(budget.native_available_atomic))
    throw new Error('MONEY_GAS_FUNDS_INSUFFICIENT');
  const supply = request.kind === 'aave_supply';
  if (
    supply &&
    (amount > BigInt(budget.usdc_available_atomic) ||
      (budget.supply_capacity_atomic !== null && amount > BigInt(budget.supply_capacity_atomic)))
  )
    throw new Error('MONEY_SUPPLY_FUNDS_INSUFFICIENT');
  if (
    !supply &&
    (amount > BigInt(budget.position_available_atomic) || amount > BigInt(budget.liquidity_atomic))
  )
    throw new Error('MONEY_WITHDRAW_FUNDS_INSUFFICIENT');
  const operation: UserOperation<'0.9'> = Object.freeze({
    sender: compiled.account,
    nonce: context.nonce,
    callData: compiled.calldata,
    ...context.gas,
    signature: '0x',
  });
  const userOpHash = getUserOperationHash({
    chainId: 421614,
    entryPointAddress: entryPoint,
    entryPointVersion: '0.9',
    userOperation: operation,
  });
  const hash = (text: string) => keccak256(stringToHex(text));
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
        hash('GatoPagoV3MoneyAssetLimits:1'),
        hash(request.asset_id),
        supply ? amount : 0n,
        supply ? 0n : amount,
        gasReserve,
      ],
    ),
  );
  const feePolicyHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [hash('GatoPagoV3MoneyFees:1'), 0n, maximumCharge, gasReserve],
    ),
  );
  const previewHash = hash(
    JSON.stringify([
      'GatoPagoV3MoneyPreview:1',
      request,
      context.market.digest,
      context.deployment_digest,
      context.policy_hash,
      context.native_asset_id,
      [
        context.checkpoint.block_number,
        context.checkpoint.block_hash,
        context.checkpoint.observed_at,
        context.checkpoint.expires_at,
      ],
      [
        budget.usdc_available_atomic,
        budget.position_available_atomic,
        budget.native_available_atomic,
        budget.maximum_native_gas_atomic,
        budget.debt_base_atomic,
        budget.liquidity_atomic,
        budget.supply_capacity_atomic,
      ],
      assetLimitsHash,
      feePolicyHash,
    ]),
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
    paymaster: zeroAddress,
    previewHash,
    nonce: context.nonce,
    validAfter: now,
    validUntil: context.valid_until,
  });
  const digest = authorizationDigest('ExecutionPlan', 421614n, compiled.account, plan);
  return Object.freeze({
    ...compiled,
    deployment_digest: context.deployment_digest,
    policy_hash: context.policy_hash,
    checkpoint: Object.freeze({ ...context.checkpoint }),
    operation,
    plan,
    digest,
    userOpHash,
    maximumEntryPointCharge: maximumCharge,
    funding: Object.freeze({
      amount_atomic: request.amount_atomic,
      asset_debit_atomic: supply ? request.amount_atomic : '0',
      position_debit_atomic: supply ? '0' : request.amount_atomic,
      maximum_native_gas_atomic: gasReserve.toString(),
    }),
  });
}
