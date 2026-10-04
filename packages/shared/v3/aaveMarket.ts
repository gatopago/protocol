import { parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { deploymentDocumentDigest, requireHash } from './deployment';
import { parseAtomicAmount } from './primitives';
import { moneyAddress, moneyFields, moneyInteger } from './moneyWire';

export const aavePoolAbi = parseAbi([
  'function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)',
  'function withdraw(address asset,uint256 amount,address to) returns (uint256)',
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getConfiguration(address asset) view returns ((uint256 data))',
  'function getReserveData(address asset) view returns (((uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)',
  'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)',
  'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
]);
export const aaveTokenAbi = parseAbi([
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function POOL() view returns (address)',
  'function scaledBalanceOf(address user) view returns (uint256)',
  'function balanceOf(address user) view returns (uint256)',
]);
export const aaveProviderAbi = parseAbi(['function getPool() view returns (address)']);
export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export interface AaveMarket {
  schema_version: 1;
  market_id: 'aave-v3-arbitrum-sepolia-usdc';
  network_id: 'eip155:421614';
  asset_id: string;
  decimals: 6;
  provider: Address;
  pool: Address;
  a_token: Address;
  genesis_hash: Hex;
  abi_sha256: Hex;
  admitted_block_number: string;
  admitted_block_hash: Hex;
  valid_from: number;
  valid_until: number;
  max_observation_age_seconds: number;
  contracts: readonly {
    name: 'provider' | 'pool' | 'token' | 'a_token';
    address: Address;
    code_hash: Hex;
    implementation: Address | null;
    implementation_code_hash: Hex | null;
  }[];
}
export interface AaveMarketPin {
  document: string;
  digest: Hex;
}
export function parseAaveMarket(value: unknown): AaveMarket {
  const input = moneyFields(value, [
    'schema_version',
    'market_id',
    'network_id',
    'asset_id',
    'decimals',
    'provider',
    'pool',
    'a_token',
    'genesis_hash',
    'abi_sha256',
    'admitted_block_number',
    'admitted_block_hash',
    'valid_from',
    'valid_until',
    'max_observation_age_seconds',
    'contracts',
  ]);
  if (
    input.schema_version !== 1 ||
    input.market_id !== 'aave-v3-arbitrum-sepolia-usdc' ||
    input.network_id !== 'eip155:421614' ||
    input.asset_id !== 'eip155:421614/erc20:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d' ||
    input.decimals !== 6
  )
    throw new Error('AAVE_MARKET_INVALID');
  for (const hash of [input.genesis_hash, input.abi_sha256, input.admitted_block_hash])
    requireHash(hash);
  const validFrom = moneyInteger(input.valid_from),
    validUntil = moneyInteger(input.valid_until);
  const age = moneyInteger(input.max_observation_age_seconds);
  if (validUntil <= validFrom || validUntil - validFrom > 90 * 86400 || age > 60)
    throw new Error('AAVE_MARKET_WINDOW_INVALID');
  const provider = moneyAddress(input.provider),
    pool = moneyAddress(input.pool),
    aToken = moneyAddress(input.a_token);
  const expected = {
    provider,
    pool,
    a_token: aToken,
    token: moneyAddress(input.asset_id.split('erc20:')[1]),
  };
  if (
    new Set(Object.values(expected).map((address) => address.toLowerCase())).size !== 4 ||
    !Array.isArray(input.contracts) ||
    input.contracts.length !== 4
  )
    throw new Error('AAVE_MARKET_CONTRACTS_INVALID');
  const seen = new Set<string>();
  const contracts = input.contracts
    .map((value) => {
      const contract = moneyFields(value, [
        'name',
        'address',
        'code_hash',
        'implementation',
        'implementation_code_hash',
      ]);
      if (
        typeof contract.name !== 'string' ||
        !Object.hasOwn(expected, contract.name) ||
        seen.has(contract.name)
      )
        throw new Error('AAVE_MARKET_CONTRACTS_INVALID');
      const name = contract.name as keyof typeof expected,
        address = moneyAddress(contract.address);
      if (address !== expected[name]) throw new Error('AAVE_MARKET_CONTRACTS_INVALID');
      seen.add(name);
      requireHash(contract.code_hash);
      if ((contract.implementation === null) !== (contract.implementation_code_hash === null))
        throw new Error('AAVE_MARKET_CONTRACTS_INVALID');
      if (contract.implementation_code_hash !== null)
        requireHash(contract.implementation_code_hash);
      return Object.freeze({
        name,
        address,
        code_hash: contract.code_hash,
        implementation:
          contract.implementation === null ? null : moneyAddress(contract.implementation),
        implementation_code_hash: contract.implementation_code_hash,
      });
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return Object.freeze({
    schema_version: 1,
    market_id: input.market_id,
    network_id: input.network_id,
    asset_id: input.asset_id,
    decimals: 6,
    provider,
    pool,
    a_token: aToken,
    genesis_hash: input.genesis_hash as Hex,
    abi_sha256: input.abi_sha256 as Hex,
    admitted_block_number: parseAtomicAmount(input.admitted_block_number),
    admitted_block_hash: input.admitted_block_hash as Hex,
    valid_from: validFrom,
    valid_until: validUntil,
    max_observation_age_seconds: age,
    contracts: Object.freeze(contracts),
  });
}
export function loadAaveMarket(pin: AaveMarketPin): AaveMarket {
  requireHash(pin.digest);
  if (
    typeof pin.document !== 'string' ||
    pin.document.length > 20_000 ||
    deploymentDocumentDigest(pin.document) !== pin.digest
  )
    throw new Error('AAVE_MARKET_PIN_INVALID');
  return parseAaveMarket(JSON.parse(pin.document));
}
export function marketToken(market: AaveMarket): Address {
  const token = market.contracts.find((contract) => contract.name === 'token')?.address;
  if (!token || token === zeroAddress) throw new Error('AAVE_MARKET_INVALID');
  return token;
}
