import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, type Address, type Hex } from 'viem';
import type { WalletNetwork } from './networks';

/** The Aave V3 Pool functions an account uses to save USDC. */
export const aavePoolAbi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]);

function market(network: WalletNetwork) {
  if (!network.aave) throw new Error(`AAVE_UNAVAILABLE: ${network.chain.id}`);
  return network.aave;
}

/** Approves and supplies `amount` USDC: one operation of the account, which receives the aUSDC. */
export function depositCalls(
  network: WalletNetwork,
  account: Address,
  amount: bigint,
): { to: Address; data: Hex }[] {
  const { pool } = market(network);
  return [
    {
      to: network.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pool, amount] }),
    },
    {
      to: pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: 'supply',
        args: [network.usdc, amount, account, 0],
      }),
    },
  ];
}

/** Withdraws `amount` USDC to the account; `'all'` includes interest accrued until execution. */
export function withdrawCalls(
  network: WalletNetwork,
  account: Address,
  amount: bigint | 'all',
): { to: Address; data: Hex }[] {
  return [
    {
      to: market(network).pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: 'withdraw',
        args: [network.usdc, amount === 'all' ? maxUint256 : amount, account],
      }),
    },
  ];
}

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

/**
 * Annual percentage yield from the reserve's `currentLiquidityRate` (a yearly rate in ray,
 * compounded every second), as Aave presents it.
 */
export function supplyApy(currentLiquidityRate: bigint): number {
  const rate = Number(currentLiquidityRate) / Number(RAY);
  return ((1 + rate / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1) * 100;
}
