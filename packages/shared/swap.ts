import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getContractAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { WalletNetwork } from './networks';

/** Uniswap v3 SwapRouter02 and QuoterV2 functions a swap uses. */
export const uniswapAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

/** Pool fee tiers compared on every quote (0.05 %, 0.3 %, 1 %). */
const FEES = [500, 3000, 10000] as const;
/** SwapRouter02 keeps the output itself when the recipient is this address (to unwrap it). */
const ROUTER_ITSELF = '0x0000000000000000000000000000000000000002';

/** What a swap exchanges: the network's USDC or its native token. */
export type SwapToken = 'usdc' | 'native';

export interface SwapQuote {
  tokenIn: SwapToken;
  tokenOut: SwapToken;
  amountIn: bigint;
  amountOut: bigint;
  fee: number;
}

function market(network: WalletNetwork) {
  if (!network.uniswap) throw new Error(`SWAP_UNAVAILABLE: ${network.chain.id}`);
  return network.uniswap;
}

/** Uniswap v3 pools are CREATE2 deployments of this init code by the factory. */
const POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';

/** The USDC/WETH pools a swap can route through, computed (no network call). */
export function swapPools(network: WalletNetwork): Address[] {
  const { factory, weth } = market(network);
  const [token0, token1] =
    network.usdc.toLowerCase() < weth.toLowerCase() ? [network.usdc, weth] : [weth, network.usdc];
  return FEES.map((fee) =>
    getContractAddress({
      opcode: 'CREATE2',
      from: factory,
      salt: keccak256(
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
          [token0, token1, fee],
        ),
      ),
      bytecodeHash: POOL_INIT_CODE_HASH,
    }),
  );
}

const address = (network: WalletNetwork, token: SwapToken) =>
  token === 'usdc' ? network.usdc : market(network).weth;

/** The best single-pool quote among the fee tiers, read in one Multicall3 call to QuoterV2. */
export async function quoteSwap(
  client: PublicClient,
  network: WalletNetwork,
  { tokenIn, tokenOut, amountIn }: { tokenIn: SwapToken; tokenOut: SwapToken; amountIn: bigint },
): Promise<SwapQuote> {
  if (tokenIn === tokenOut || amountIn <= 0n) throw new Error('INVALID_SWAP');
  const results = await client.multicall({
    contracts: FEES.map((fee) => ({
      address: market(network).quoter,
      abi: uniswapAbi,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: address(network, tokenIn),
          tokenOut: address(network, tokenOut),
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })),
  });
  let best: SwapQuote | null = null;
  results.forEach((result, i) => {
    if (result.status !== 'success') return;
    const [amountOut] = result.result as readonly [bigint, bigint, number, bigint];
    if (!best || amountOut > best.amountOut)
      best = { tokenIn, tokenOut, amountIn, amountOut, fee: FEES[i] };
  });
  if (!best) throw new Error('NO_SWAP_ROUTE');
  return best;
}

/** The least a quote may deliver after `slippageBps` (default 0.5 %). */
export const minimumOut = (quote: SwapQuote, slippageBps = 50) =>
  (quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;

/**
 * Calls that execute `quote` from `account` in one operation: native token in is sent as value
 * (the router wraps it); native token out is unwrapped by the router to the account.
 */
export function swapCalls(
  network: WalletNetwork,
  account: Address,
  quote: SwapQuote,
  amountOutMinimum: bigint,
): { to: Address; data: Hex; value?: bigint }[] {
  const { router } = market(network);
  const unwrap = quote.tokenOut === 'native';
  const swap = encodeFunctionData({
    abi: uniswapAbi,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: address(network, quote.tokenIn),
        tokenOut: address(network, quote.tokenOut),
        fee: quote.fee,
        recipient: unwrap ? ROUTER_ITSELF : account,
        amountIn: quote.amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const call = unwrap
    ? encodeFunctionData({
        abi: uniswapAbi,
        functionName: 'multicall',
        args: [
          [
            swap,
            encodeFunctionData({
              abi: uniswapAbi,
              functionName: 'unwrapWETH9',
              args: [amountOutMinimum, account],
            }),
          ],
        ],
      })
    : swap;
  if (quote.tokenIn === 'native') return [{ to: router, data: call, value: quote.amountIn }];
  return [
    {
      to: network.usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [router, quote.amountIn],
      }),
    },
    { to: router, data: call },
  ];
}
