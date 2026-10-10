import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Client, type Hex } from 'viem';
import { readContract } from 'viem/actions';
import type { WalletNetwork } from './networks';

/**
 * Agora Instant Settlement: a pair that exchanges two coins at a fixed price, without slippage
 * (Uniswap v2 interface). Paying through it settles a send in the recipient's coin in the same
 * operation. Only allow-listed addresses swap: on mainnet after Agora's KYC; on testnets anyone
 * allow-lists itself through the `whitelister`.
 */
const instantSettlementAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
  'function hasRole(string role, address account) view returns (bool)',
]);
const whitelisterAbi = parseAbi(['function setApprovedSwapper(address swapper)']);

/** How long a signed settlement stays valid: past it, the pair refuses it. */
const DEADLINE_SECONDS = 600n;

function pairOf(network: WalletNetwork) {
  if (!network.instantSettlement) throw new Error(`SETTLEMENT_UNAVAILABLE: ${network.chain.id}`);
  return network.instantSettlement;
}

/** What `amountIn` of `tokenIn` settles into, at the pair's fixed price with its fee taken. */
export async function quoteSettlement(
  client: Client,
  network: WalletNetwork,
  trade: { tokenIn: Address; tokenOut: Address; amountIn: bigint },
): Promise<bigint> {
  const amounts = await readContract(client, {
    address: pairOf(network).pair,
    abi: instantSettlementAbi,
    functionName: 'getAmountsOut',
    args: [trade.amountIn, [trade.tokenIn, trade.tokenOut]],
  });
  return amounts[1];
}

/** Whether `account` may swap on the network's pair already. */
export function settlementAllowed(client: Client, network: WalletNetwork, account: Address) {
  return readContract(client, {
    address: pairOf(network).pair,
    abi: instantSettlementAbi,
    functionName: 'hasRole',
    args: ['APPROVED_SWAPPER', account],
  });
}

/**
 * Calls that settle `amountIn` of `tokenIn` into at least `minOut` of `tokenOut` for `recipient`:
 * allow-listing `account` first when it is not yet and the network lets it (testnets), approving
 * the pair, and swapping with the output sent straight to the recipient. One operation.
 */
export function settlementCalls(
  network: WalletNetwork,
  settlement: {
    account: Address;
    allowListed: boolean;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    minOut: bigint;
    recipient: Address;
    /** Unix seconds when the signature is made; the pair accepts it for ten minutes. */
    now: bigint;
  },
): { to: Address; data: Hex }[] {
  const { pair, whitelister } = pairOf(network);
  if (!settlement.allowListed && !whitelister) throw new Error('SETTLEMENT_NOT_ALLOWED');
  return [
    ...(settlement.allowListed
      ? []
      : [
          {
            to: whitelister!,
            data: encodeFunctionData({
              abi: whitelisterAbi,
              functionName: 'setApprovedSwapper',
              args: [settlement.account],
            }),
          },
        ]),
    {
      to: settlement.tokenIn,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [pair, settlement.amountIn],
      }),
    },
    {
      to: pair,
      data: encodeFunctionData({
        abi: instantSettlementAbi,
        functionName: 'swapExactTokensForTokens',
        args: [
          settlement.amountIn,
          settlement.minOut,
          [settlement.tokenIn, settlement.tokenOut],
          settlement.recipient,
          settlement.now + DEADLINE_SECONDS,
        ],
      }),
    },
  ];
}
