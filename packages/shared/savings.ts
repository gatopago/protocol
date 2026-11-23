import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  maxUint256,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { walletNetworks } from './networks';

/**
 * Where an account's USDC earns: lending markets and vaults the account deposits into directly, with
 * its own signature. GatoPago never holds the money; these adapters only build the account's calls
 * and read the chain (roadmap/FASE-12-DEFI.md, layer 1).
 */

/** How much risk a provider carries. A person accepts a tier once, with its risk sheet in view. */
export type SavingsTier = 'stable' | 'plus' | 'turbo';

/** Who holds a power over a provider, and how long until it takes effect. */
export interface Control {
  readonly holder: 'dao' | 'multisig' | 'eoa';
  /** Signatures needed, of how many signers (a multisig). */
  readonly signers?: readonly [number, number];
  /** Hours before it takes effect; 0 is at once. */
  readonly delayHours: number;
}

/**
 * What a person sees before accepting a provider, read on chain on `checked`. The app words it;
 * these are the facts. `pause` is who can stop withdrawals, `curator` who decides where a vault's
 * money goes (new destinations take `delayHours`), `collateral` what backs most of the loans when
 * a vault sits in a few markets.
 */
export interface RiskSheet {
  readonly strategy: 'lending' | 'curated' | 'savings-rate';
  readonly upgrade: Control | 'immutable';
  readonly pause: Control | 'none';
  readonly curator?: Control;
  readonly collateral?: readonly string[];
  readonly audits: readonly string[];
  /** Losses that touched the protocol, even when depositors were made whole. */
  readonly incidents: readonly { readonly date: string; readonly url: string }[];
  readonly checked: string;
}

/**
 * A provider and the contracts its account calls. `asset` is the network's Circle USDC; `network` a
 * CAIP-2 id. Every kind deposits and withdraws with the account as owner and receiver.
 */
export type SavingsProvider = {
  readonly id: string;
  readonly network: string;
  readonly asset: Address;
  /** Testnet providers hold test money and have no sheet. */
  readonly risk: RiskSheet | 'testnet';
} & (
  | {
      /** Aave v3: the Pool, and the aToken it mints (whose balance grows). */
      readonly kind: 'aave-v3';
      readonly pool: Address;
      readonly aToken: Address;
      /**
       * `false` for a Pool before v3.1 (Arbitrum Sepolia's), which has no virtual balance: there a
       * withdrawal is limited only by the USDC the aToken holds.
       */
      readonly virtualBalance?: false;
    }
  | {
      /** An ERC-4626 vault whose `maxWithdraw` counts its own liquidity (Fluid, Spark, Euler Earn). */
      readonly kind: 'erc4626';
      readonly vault: Address;
    }
  | {
      /**
       * A Morpho Vault V2. Its `maxWithdraw` is always zero: a withdrawal takes the vault's idle USDC
       * and then deallocates from its liquidity adapter, so that is what can leave now.
       */
      readonly kind: 'morpho-v2';
      readonly vault: Address;
    }
  | {
      /**
       * A Compound v2 market (BENQI). `mint` and `redeemUnderlying` return an error code instead of
       * reverting, and a batch cannot read it: a refused deposit leaves the USDC in the account, and
       * a refused withdrawal leaves it in the market, so read `position` after either. A withdrawal
       * followed by a payment cannot pay without the USDC, so that batch still reverts as a whole.
       */
      readonly kind: 'compound-v2';
      readonly market: Address;
    }
);

/**
 * The tier follows from who can act on the money, and from how concentrated the loans are. Any
 * power held by a single key (an EOA) makes it turbo. Otherwise it is plus when a multisig can change
 * the code or when most of the loans rest on a few collaterals, and stable when only a DAO vote can
 * change the code (or nobody can). Delays do not move the tier, they are on the sheet: a multisig
 * is plus whether it acts at once or after a day. An emergency pause by a multisig does not lower
 * the tier either: it protects. The collaterals themselves are judged on the sheet, not here.
 */
export function savingsTier(provider: SavingsProvider): SavingsTier {
  const { risk } = provider;
  if (risk === 'testnet') return 'stable';
  const powers = [risk.upgrade, risk.pause, risk.curator].filter(
    (power): power is Control => typeof power === 'object',
  );
  if (powers.some(({ holder }) => holder === 'eoa')) return 'turbo';
  if (risk.collateral) return 'plus';
  return risk.upgrade === 'immutable' || risk.upgrade.holder === 'dao' ? 'stable' : 'plus';
}

const usdc = {
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  avalanche: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  monad: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
} as const;

const arbitrumSepolia = walletNetworks['eip155:421614'];
const avalancheFuji = walletNetworks['eip155:43113'];

const CHECKED = '2026-11-23';
const aave = {
  strategy: 'lending',
  // A vote of Aave Governance v3 on Ethereum, then a day in the network's Executor.
  upgrade: { holder: 'dao', delayHours: 24 },
  // The Aave Protocol Guardian (Safe 4/7): emergency admin only.
  pause: { holder: 'multisig', signers: [4, 7], delayHours: 0 },
  audits: ['https://github.com/aave-dao/aave-v3-origin/tree/feat/V3.8/audits'],
  incidents: [
    { date: '2026-03-10', url: 'https://www.theblock.co/post/393121' },
    {
      date: '2026-04-18',
      url: 'https://governance.aave.com/t/rseth-incident-report-april-20-2026/24580',
    },
  ],
  checked: CHECKED,
} as const satisfies RiskSheet;

/**
 * Every provider, checked on chain on 23-11-2026: asset, size, liquidity and who holds each power
 * (owners read as EOAs or Safes). Aave from bgd-labs/aave-address-book, Spark from
 * sparkdotfi/spark-address-registry, Fluid from its lending API, Euler Earn from
 * euler-xyz/euler-labels and Morpho from its API. Mainnet ones are defined but not offered by the
 * app yet.
 */
export const savingsProviders = [
  {
    id: 'aave-v3-arbitrum-sepolia',
    network: 'eip155:421614',
    asset: arbitrumSepolia.usdc,
    risk: 'testnet',
    kind: 'aave-v3',
    ...arbitrumSepolia.aave,
    virtualBalance: false,
  },
  {
    id: 'aave-v3-avalanche-fuji',
    network: 'eip155:43113',
    asset: avalancheFuji.usdc,
    risk: 'testnet',
    kind: 'aave-v3',
    ...avalancheFuji.aave,
  },
  {
    id: 'aave-v3-arbitrum',
    network: 'eip155:42161',
    asset: usdc.arbitrum,
    risk: aave,
    kind: 'aave-v3',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    aToken: '0x724dc807b04555b71ed48a6896b6F41593b8C637',
  },
  {
    id: 'fluid-fusdc-arbitrum',
    network: 'eip155:42161',
    asset: usdc.arbitrum,
    // Fluid's team multisig (Avocado 6/12) proposes to the Liquidity layer's 1-day timelock, and as
    // its guardian can pause fUSDC's withdrawals at once.
    risk: {
      strategy: 'lending',
      upgrade: { holder: 'multisig', signers: [6, 12], delayHours: 24 },
      pause: { holder: 'multisig', signers: [6, 12], delayHours: 0 },
      audits: ['https://docs.fluid.instadapp.io/audits-and-security.html'],
      incidents: [
        {
          date: '2026-03',
          url: 'https://www.kucoin.com/news/flash/fluid-completes-resolution-of-resolv-incident-19-3m-usd-bad-debt-shared-among-parties',
        },
        {
          date: '2026-05-27',
          url: 'https://www.cryptotimes.io/2026/05/31/fluid-protocol-loses-125k-fluid-51-9k-gho-in-key-compromise-attack/',
        },
      ],
      checked: CHECKED,
    },
    kind: 'erc4626',
    vault: '0x1A996cb54bb95462040408C06122D45D6Cdb6096',
  },
  {
    id: 'spark-susdc-arbitrum',
    network: 'eip155:42161',
    asset: usdc.arbitrum,
    // Upgraded by Sky's governance: a vote on Ethereum, 48 hours in its pause (MCD_PAUSE in Sky's
    // chainlog), then Spark's Arbitrum executor, which adds no delay. Nothing pauses it, and `exit`
    // always pays sUSDS; USDC leaves only as far as the PSM3 holds it.
    risk: {
      strategy: 'savings-rate',
      upgrade: { holder: 'dao', delayHours: 48 },
      pause: 'none',
      audits: ['https://github.com/sparkdotfi/spark-vaults/tree/master/audits'],
      incidents: [],
      checked: CHECKED,
    },
    kind: 'erc4626',
    vault: '0x940098b108fB7D0a7E374f6eDED7760787464609',
  },
  {
    id: 'aave-v3-avalanche',
    network: 'eip155:43114',
    asset: usdc.avalanche,
    risk: aave,
    kind: 'aave-v3',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    aToken: '0x625E7708f30cA75bfd92586e17077590C60eb4cD',
  },
  {
    id: 'benqi-qiusdcn-avalanche',
    network: 'eip155:43114',
    asset: usdc.avalanche,
    // A Safe 3/6 replaces the market, the Comptroller and the oracle at once. Withdrawals cannot be
    // paused (only deposits, borrows and transfers).
    risk: {
      strategy: 'lending',
      upgrade: { holder: 'multisig', signers: [3, 6], delayHours: 0 },
      pause: 'none',
      audits: ['https://docs.benqi.fi/resources/risks'],
      incidents: [],
      checked: CHECKED,
    },
    kind: 'compound-v2',
    market: '0xB715808a78F6041E46d61Cb123C9B4A27056AE9C',
  },
  {
    id: 'aave-v3-monad',
    network: 'eip155:143',
    asset: usdc.monad,
    // On Monad the Guardian (Safe 4/7) is also pool admin: it can replace the aToken at once.
    risk: { ...aave, upgrade: { holder: 'multisig', signers: [4, 7], delayHours: 0 } },
    kind: 'aave-v3',
    pool: '0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef',
    aToken: '0x35a73BAcb179d3740395A3ceCc87FF2e581d6042',
  },
  {
    id: 'euler-clearstar-monad',
    network: 'eip155:143',
    asset: usdc.monad,
    // The vault's owner is an EOA and acts as curator. Its markets are Euler vaults that Euler's
    // DAO multisig (4/8) upgrades through a 4-day timelock, and that Euler's pause guardians (two of
    // them EOAs) can freeze at once. All of it is lent against FXRP.
    risk: {
      strategy: 'curated',
      upgrade: { holder: 'multisig', signers: [4, 8], delayHours: 96 },
      pause: { holder: 'eoa', delayHours: 0 },
      curator: { holder: 'eoa', delayHours: 48 },
      collateral: ['FXRP'],
      audits: [
        'https://github.com/euler-xyz/euler-earn/tree/master/audits',
        'https://github.com/euler-xyz/euler-vault-kit/tree/master/audits',
      ],
      incidents: [{ date: '2023-03-13', url: 'https://rekt.news/euler-rekt' }],
      checked: CHECKED,
    },
    kind: 'erc4626',
    vault: '0xE1BcA19baA63894D374578320551633320436523',
  },
  {
    id: 'morpho-august-monad',
    network: 'eip155:143',
    asset: usdc.monad,
    // Immutable code, but owner, curator, allocator and sentinel are EOAs. All of it sits in one
    // market lent against earnAUSD, whose price comes from August's own vault.
    risk: {
      strategy: 'curated',
      upgrade: 'immutable',
      pause: { holder: 'eoa', delayHours: 168 },
      curator: { holder: 'eoa', delayHours: 72 },
      collateral: ['earnAUSD'],
      audits: ['https://github.com/morpho-org/vault-v2/tree/main/audits'],
      incidents: [
        {
          date: '2024-10',
          url: 'https://thedefiant.io/news/defi/morpho-user-exploits-oracle-error-to-turn-usd350-into-usd230k',
        },
        { date: '2025-04-10', url: 'https://morpho.org/blog/morpho-app-incident-april-10-2025/' },
      ],
      checked: CHECKED,
    },
    kind: 'morpho-v2',
    vault: '0x80017bF0f793EBbE9679Cd61ff0e395B62CAbB59',
  },
] as const satisfies readonly SavingsProvider[];

export type SavingsProviderId = (typeof savingsProviders)[number]['id'];

export function savingsProvider(id: string): SavingsProvider {
  const provider = savingsProviders.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`UNKNOWN_SAVINGS_PROVIDER: ${id}`);
  return provider;
}

const aaveAbi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
  'function getVirtualUnderlyingBalance(address asset) view returns (uint128)',
  'function scaledBalanceOf(address user) view returns (uint256)',
]);

const vaultAbi = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function maxWithdraw(address owner) view returns (uint256)',
  'function liquidityAdapter() view returns (address)',
  'function liquidityData() view returns (bytes)',
  'function morpho() view returns (address)',
]);

const morphoAbi = parseAbi([
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
]);
const marketParams = parseAbiParameters(
  '(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
);

// `exchangeRateCurrent` accrues interest and is not `view`; read through `eth_call`, it is the rate
// a transaction would use now (`exchangeRateStored` lags until the market's next interaction).
const compoundAbi = parseAbi([
  'function mint(uint256 mintAmount) returns (uint256)',
  'function redeem(uint256 redeemTokens) returns (uint256)',
  'function redeemUnderlying(uint256 redeemAmount) returns (uint256)',
  'function exchangeRateCurrent() view returns (uint256)',
  'function getCash() view returns (uint256)',
]);

/** One call of the account's batch. */
export interface SavingsCall {
  readonly to: Address;
  readonly data: Hex;
}

/** What an account holds in a provider: its shares and what they redeem for now, in USDC. */
export interface SavingsPosition {
  readonly account: Address;
  readonly shares: bigint;
  readonly assets: bigint;
}

const approve = (provider: SavingsProvider, spender: Address, amount: bigint): SavingsCall => ({
  to: provider.asset,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
});

/** Approves exactly `amount` USDC and deposits it for the account: one operation. */
export function depositCalls(
  provider: SavingsProvider,
  account: Address,
  amount: bigint,
): SavingsCall[] {
  if (amount <= 0n) throw new Error('INVALID_AMOUNT');
  switch (provider.kind) {
    case 'aave-v3':
      return [
        approve(provider, provider.pool, amount),
        {
          to: provider.pool,
          data: encodeFunctionData({
            abi: aaveAbi,
            functionName: 'supply',
            args: [provider.asset, amount, account, 0],
          }),
        },
      ];
    case 'erc4626':
    case 'morpho-v2':
      return [
        approve(provider, provider.vault, amount),
        {
          to: provider.vault,
          data: encodeFunctionData({
            abi: vaultAbi,
            functionName: 'deposit',
            args: [amount, account],
          }),
        },
      ];
    case 'compound-v2':
      return [
        approve(provider, provider.market, amount),
        {
          to: provider.market,
          data: encodeFunctionData({ abi: compoundAbi, functionName: 'mint', args: [amount] }),
        },
      ];
  }
}

/**
 * Withdraws `amount` USDC to the account, or `'all'`: every share of `position`, with what it
 * earned until the withdrawal runs.
 */
export function withdrawCalls(
  provider: SavingsProvider,
  position: SavingsPosition,
  amount: bigint | 'all',
): SavingsCall[] {
  if (amount !== 'all' && amount <= 0n) throw new Error('INVALID_AMOUNT');
  const { account, shares } = position;
  switch (provider.kind) {
    case 'aave-v3':
      return [
        {
          to: provider.pool,
          data: encodeFunctionData({
            abi: aaveAbi,
            functionName: 'withdraw',
            args: [provider.asset, amount === 'all' ? maxUint256 : amount, account],
          }),
        },
      ];
    case 'erc4626':
    case 'morpho-v2':
      return [
        {
          to: provider.vault,
          data:
            amount === 'all'
              ? encodeFunctionData({
                  abi: vaultAbi,
                  functionName: 'redeem',
                  args: [shares, account, account],
                })
              : encodeFunctionData({
                  abi: vaultAbi,
                  functionName: 'withdraw',
                  args: [amount, account, account],
                }),
        },
      ];
    case 'compound-v2':
      return [
        {
          to: provider.market,
          data:
            amount === 'all'
              ? encodeFunctionData({ abi: compoundAbi, functionName: 'redeem', args: [shares] })
              : encodeFunctionData({
                  abi: compoundAbi,
                  functionName: 'redeemUnderlying',
                  args: [amount],
                }),
        },
      ];
  }
}

const balanceOf = (client: PublicClient, token: Address, owner: Address) =>
  client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });

/** The account's shares in the provider and the USDC they are worth now. */
export async function position(
  client: PublicClient,
  provider: SavingsProvider,
  account: Address,
): Promise<SavingsPosition> {
  switch (provider.kind) {
    case 'aave-v3': {
      const [shares, assets] = await Promise.all([
        client.readContract({
          address: provider.aToken,
          abi: aaveAbi,
          functionName: 'scaledBalanceOf',
          args: [account],
        }),
        balanceOf(client, provider.aToken, account),
      ]);
      return { account, shares, assets };
    }
    case 'erc4626':
    case 'morpho-v2': {
      const shares = await balanceOf(client, provider.vault, account);
      const assets = await client.readContract({
        address: provider.vault,
        abi: vaultAbi,
        functionName: 'previewRedeem',
        args: [shares],
      });
      return { account, shares, assets };
    }
    case 'compound-v2': {
      const [shares, rate] = await Promise.all([
        balanceOf(client, provider.market, account),
        growthIndex(client, provider),
      ]);
      return { account, shares, assets: (shares * rate) / 10n ** 18n };
    }
  }
}

/**
 * How much of the account's position can be withdrawn right now: a lending market only pays out
 * what is not lent, and a vault only what its liquidity reaches. Since v3.1, Aave counts what is not
 * lent in a virtual balance, below the aToken's USDC when someone donated to it.
 */
export async function withdrawable(
  client: PublicClient,
  provider: SavingsProvider,
  account: Address,
): Promise<bigint> {
  if (provider.kind === 'erc4626')
    return client.readContract({
      address: provider.vault,
      abi: vaultAbi,
      functionName: 'maxWithdraw',
      args: [account],
    });
  const [{ assets }, liquidity] = await Promise.all([
    position(client, provider, account),
    provider.kind === 'aave-v3'
      ? aaveLiquidity(client, provider)
      : provider.kind === 'morpho-v2'
        ? morphoLiquidity(client, provider.vault, provider.asset)
        : client.readContract({
            address: provider.market,
            abi: compoundAbi,
            functionName: 'getCash',
          }),
  ]);
  return assets < liquidity ? assets : liquidity;
}

async function aaveLiquidity(
  client: PublicClient,
  provider: Extract<SavingsProvider, { kind: 'aave-v3' }>,
) {
  const [held, unlent] = await Promise.all([
    balanceOf(client, provider.asset, provider.aToken),
    provider.virtualBalance === false
      ? undefined
      : client.readContract({
          address: provider.pool,
          abi: aaveAbi,
          functionName: 'getVirtualUnderlyingBalance',
          args: [provider.asset],
        }),
  ]);
  return unlent !== undefined && unlent < held ? unlent : held;
}

/**
 * A Morpho Vault V2's idle USDC plus what its liquidity adapter can take out of its Morpho market:
 * the adapter's supply, up to what the market has not lent. An adapter that is not a market
 * adapter counts as nothing, so the vault is never thought more liquid than it is.
 */
async function morphoLiquidity(client: PublicClient, vault: Address, asset: Address) {
  const [idle, adapter, data] = await Promise.all([
    balanceOf(client, asset, vault),
    client.readContract({ address: vault, abi: vaultAbi, functionName: 'liquidityAdapter' }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: 'liquidityData' }),
  ]);
  if (adapter === zeroAddress || (data.length - 2) / 2 !== 5 * 32) return idle;
  const [params] = decodeAbiParameters(marketParams, data);
  if (params.loanToken.toLowerCase() !== asset.toLowerCase()) return idle;
  const id = keccak256(encodeAbiParameters(marketParams, [params]));
  const morpho = await client.readContract({
    address: adapter,
    abi: vaultAbi,
    functionName: 'morpho',
  });
  const [[supplyAssets, supplyShares, borrowAssets], [adapterShares]] = await Promise.all([
    client.readContract({ address: morpho, abi: morphoAbi, functionName: 'market', args: [id] }),
    client.readContract({
      address: morpho,
      abi: morphoAbi,
      functionName: 'position',
      args: [id, adapter],
    }),
  ]);
  // Morpho's own rounding down, with its virtual shares (1e6) and virtual assets (1).
  const supplied = (adapterShares * (supplyAssets + 1n)) / (supplyShares + 10n ** 6n);
  const unlent = supplyAssets - borrowAssets;
  return idle + (supplied < unlent ? supplied : unlent);
}

/**
 * A number that grows with what the provider earns: Aave's normalized income, a vault's assets per
 * 10^18 shares, a Compound market's exchange rate. Only the ratio of two readings means anything
 * (`realizedRate`); a reading below an earlier one is a loss.
 */
export function growthIndex(client: PublicClient, provider: SavingsProvider): Promise<bigint> {
  switch (provider.kind) {
    case 'aave-v3':
      return client.readContract({
        address: provider.pool,
        abi: aaveAbi,
        functionName: 'getReserveNormalizedIncome',
        args: [provider.asset],
      });
    case 'erc4626':
    case 'morpho-v2':
      return client.readContract({
        address: provider.vault,
        abi: vaultAbi,
        functionName: 'convertToAssets',
        args: [10n ** 18n],
      });
    case 'compound-v2':
      return client.readContract({
        address: provider.market,
        abi: compoundAbi,
        functionName: 'exchangeRateCurrent',
      });
  }
}

/** A `growthIndex` reading and when it was taken (unix seconds). */
export interface GrowthReading {
  readonly index: bigint;
  readonly at: number;
}

const SECONDS_PER_YEAR = 31_536_000;

/**
 * The yearly rate two readings imply, compounded, as a fraction (0.05 is 5 %): what the provider
 * actually paid, not what it advertises. Negative after a loss.
 */
export function realizedRate(earlier: GrowthReading, later: GrowthReading): number {
  if (earlier.index <= 0n || later.at <= earlier.at) throw new Error('INVALID_READINGS');
  const growth = Number((later.index * 10n ** 18n) / earlier.index) / 1e18;
  return growth ** (SECONDS_PER_YEAR / (later.at - earlier.at)) - 1;
}
