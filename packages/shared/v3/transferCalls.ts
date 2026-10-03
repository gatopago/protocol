import { encodeFunctionData, erc20Abi, getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from 'viem';
import { hashCalls, type AccountCall } from './authorizations';
import { encodeAccountExecution } from './execution';
import { assertAssetNetwork } from './primitives';
import { parseTransferRequest, resolveTransferFunding, type TransferRequest } from './transfer';

/** Pure call compiler for an already verified account-specific funding budget.
 * Not a quote or authorization. The caller must admit assets/providers, verify
 * ownership/security/finality/reservations and simulate the complete batch.
 * ERC20 return values/events and actual settlement still require verification:
 * a successful low-level CALL alone does not prove the recipient was paid.
 */
export function compileTransferCalls(input: TransferRequest, context: {
  account: Address;
  security_version: bigint;
  native_asset_id: string;
  budget: Parameters<typeof resolveTransferFunding>[1];
  fee_recipient: Address | null;
}) {
  const request = parseTransferRequest(input);
  const account = checkedAddress(context.account);
  const destination = checkedAddress(request.destination.address);
  if (isAddressEqual(destination, account)) throw new Error('Self transfer is not an external transfer');
  assertAssetNetwork(context.native_asset_id, request.network_id);
  if (!context.native_asset_id.split('/')[1].startsWith('slip44:')) throw new Error('Native asset identity required');
  const native = request.asset_id === context.native_asset_id;
  const asset = request.asset_id.split('/')[1];
  if (!native && !asset.startsWith('erc20:')) throw new Error('Unsupported fungible asset identity');
  const token = native ? null : checkedAddress(asset.slice('erc20:'.length));
  if (token && (isAddressEqual(token, account) || isAddressEqual(token, destination))) throw new Error('Invalid token transfer destination');
  const funding = resolveTransferFunding(request, context.budget);
  const fee = BigInt(context.budget.platform_fee.amount_atomic);
  if ((fee === 0n) !== (context.fee_recipient === null)) throw new Error('Fee recipient must match explicit fee');
  const feeRecipient = fee === 0n ? null : checkedAddress(context.fee_recipient!);
  if (feeRecipient && (isAddressEqual(feeRecipient, account) || (token && isAddressEqual(feeRecipient, token)))) {
    throw new Error('Invalid fee recipient');
  }
  const call = (recipient: Address, amount: bigint): AccountCall => token
    ? { target: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, amount] }) }
    : { target: recipient, value: amount, data: '0x' };
  const calls = [call(destination, BigInt(funding.amount_atomic))];
  if (feeRecipient) calls.push(call(feeRecipient, fee));
  // Reuses the account execution encoder: CALL only, no approvals/delegatecall
  // and no user-controlled calldata. Gas is reserved, never paid as a batch call.
  const calldata = encodeAccountExecution(account, calls, context.security_version);
  return { request, account, funding, calls, calls_hash: hashCalls(calls), calldata };
}

function checkedAddress(value: string): Address {
  if (!isAddress(value, { strict: true }) || isAddressEqual(value as Address, zeroAddress)) throw new Error('Invalid transfer address');
  return getAddress(value);
}
