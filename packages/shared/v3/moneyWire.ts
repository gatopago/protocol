import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import { parseAtomicAmount, parseResourceId, type ResourceId } from './primitives';

export const MONEY_KINDS = ['aave_supply', 'aave_withdraw', 'aave_withdraw_and_pay'] as const;
export type MoneyKind = (typeof MONEY_KINDS)[number];
export interface MoneyOperationRequest {
  schema_version: 1;
  kind: MoneyKind;
  wallet_id: ResourceId<'wallet'>;
  wallet_account_id: ResourceId<'walletAccount'>;
  network_id: 'eip155:421614';
  market_id: 'aave-v3-arbitrum-sepolia-usdc';
  asset_id: string;
  amount_atomic: string;
  client_release_id: string;
  recipient_address?: Address;
}

export function moneyFields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('MONEY_FIELDS_INVALID');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== names.length ||
    names.some((name) => !Object.hasOwn(record, name))
  )
    throw new Error('MONEY_FIELDS_INVALID');
  return record;
}
export function moneyAddress(value: unknown): Address {
  if (
    typeof value !== 'string' ||
    !isAddress(value, { strict: true }) ||
    value.toLowerCase() === zeroAddress
  ) {
    throw new Error('MONEY_ADDRESS_INVALID');
  }
  return getAddress(value);
}
export function moneyInteger(value: unknown, positive = true): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new Error('MONEY_INTEGER_INVALID');
  return value;
}
export function parseMoneyRequest(value: unknown): MoneyOperationRequest {
  if (!value || typeof value !== 'object') throw new Error('MONEY_REQUEST_INVALID');
  const pay = 'kind' in value && value.kind === 'aave_withdraw_and_pay';
  const input = moneyFields(value, [
    'schema_version',
    'kind',
    'wallet_id',
    'wallet_account_id',
    'network_id',
    'market_id',
    'asset_id',
    'amount_atomic',
    'client_release_id',
    ...(pay ? ['recipient_address'] : []),
  ]);
  if (
    input.schema_version !== 1 ||
    !MONEY_KINDS.includes(input.kind as MoneyKind) ||
    input.network_id !== 'eip155:421614' ||
    input.market_id !== 'aave-v3-arbitrum-sepolia-usdc' ||
    input.asset_id !== 'eip155:421614/erc20:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d' ||
    typeof input.client_release_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.client_release_id)
  ) {
    throw new Error('MONEY_REQUEST_INVALID');
  }
  const amount = parseAtomicAmount(input.amount_atomic);
  if (amount === '0' || BigInt(amount) === (1n << 256n) - 1n)
    throw new Error('MONEY_EXACT_AMOUNT_REQUIRED');
  return Object.freeze({
    schema_version: 1,
    kind: input.kind as MoneyKind,
    wallet_id: parseResourceId('wallet', input.wallet_id),
    wallet_account_id: parseResourceId('walletAccount', input.wallet_account_id),
    network_id: input.network_id,
    market_id: input.market_id,
    asset_id: input.asset_id,
    amount_atomic: amount,
    client_release_id: input.client_release_id,
    ...(pay ? { recipient_address: moneyAddress(input.recipient_address) } : {}),
  });
}
