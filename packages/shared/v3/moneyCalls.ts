import { encodeFunctionData, erc20Abi, isAddressEqual, type Address } from 'viem';
import { encodeAccountExecution } from './execution';
import { hashCalls, type AccountCall } from './authorizations';
import { aavePoolAbi, loadAaveMarket, marketToken, type AaveMarketPin } from './aaveMarket';
import { moneyAddress, parseMoneyRequest, type MoneyOperationRequest } from './moneyWire';

/** Pure recipe compiler. It proves neither market admission nor effects. */
export function compileMoneyCalls(input: MoneyOperationRequest, context: {
  account: Address; security_version: bigint; market: AaveMarketPin;
}) {
  const request = parseMoneyRequest(input), account = moneyAddress(context.account), market = loadAaveMarket(context.market);
  if (request.network_id !== market.network_id || request.market_id !== market.market_id || request.asset_id !== market.asset_id) throw new Error('MONEY_MARKET_MISMATCH');
  const token = marketToken(market), amount = BigInt(request.amount_atomic);
  if ([token, market.pool, market.provider, market.a_token].some(address => isAddressEqual(account, address))) throw new Error('MONEY_ACCOUNT_INVALID');
  const calls: AccountCall[] = [];
  const approve = (value: bigint): AccountCall => ({ target: token, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [market.pool, value] }) });
  if (request.kind === 'aave_supply') {
    calls.push(approve(0n), approve(amount), { target: market.pool, value: 0n,
      data: encodeFunctionData({ abi: aavePoolAbi, functionName: 'supply', args: [token, amount, account, 0] }) }, approve(0n));
  } else {
    calls.push({ target: market.pool, value: 0n,
      data: encodeFunctionData({ abi: aavePoolAbi, functionName: 'withdraw', args: [token, amount, account] }) });
    if (request.kind === 'aave_withdraw_and_pay') {
      const recipient = moneyAddress(request.recipient_address);
      if ([account, token, market.pool, market.provider, market.a_token].some(address => isAddressEqual(recipient, address))) throw new Error('MONEY_RECIPIENT_INVALID');
      calls.push({ target: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, amount] }) });
    }
  }
  calls.forEach(Object.freeze);
  return Object.freeze({ request, account, market, calls: Object.freeze(calls), calls_hash: hashCalls(calls),
    calldata: encodeAccountExecution(account, calls, context.security_version) });
}
