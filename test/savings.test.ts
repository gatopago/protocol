import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestClient,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  http,
  maxUint256,
  parseAbi,
  parseAbiParameters,
  publicActions,
  walletActions,
  type Address,
  type Chain,
  type PublicClient,
} from 'viem';
import { arbitrum, avalanche, monad } from 'viem/chains';
import {
  depositCalls,
  growthIndex,
  position,
  realizedRate,
  savingsProvider,
  savingsProviders,
  savingsTier,
  withdrawable,
  withdrawCalls,
  type SavingsCall,
  type SavingsProvider,
} from '../packages/shared/savings';
import { walletNetworks } from '../packages/shared/networks';
import { startFork } from './anvil';

const account = getAddress('0x00000000000000000000000000000000000a11ce');
const abi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
  'function mint(uint256 mintAmount) returns (uint256)',
  'function redeem(uint256 redeemTokens) returns (uint256)',
  'function redeemUnderlying(uint256 redeemAmount) returns (uint256)',
]);
const morpho = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'function liquidityAdapter() view returns (address)',
  'function liquidityData() view returns (bytes)',
  'function morpho() view returns (address)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function supplyCollateral(MarketParams marketParams, uint256 assets, address onBehalf, bytes data)',
  'function borrow(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)',
]);
const marketParams = parseAbiParameters(
  '(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
);
const decode = (call: SavingsCall) => decodeFunctionData({ abi, data: call.data });
const decodeApprove = (call: SavingsCall) => decodeFunctionData({ abi: erc20Abi, data: call.data });

describe('savings providers', () => {
  it('are unique, and use each testnet’s USDC and Aave market', () => {
    expect(new Set(savingsProviders.map(({ id }) => id)).size).toBe(savingsProviders.length);
    const sepolia = savingsProvider('aave-v3-arbitrum-sepolia');
    expect(sepolia).toMatchObject({
      asset: walletNetworks['eip155:421614'].usdc,
      ...walletNetworks['eip155:421614'].aave,
    });
    expect(() => savingsProvider('nope')).toThrow('UNKNOWN_SAVINGS_PROVIDER');
  });

  it('take their tier from who can act on the money, and every mainnet one has its sheet', () => {
    expect(Object.fromEntries(savingsProviders.map((p) => [p.id, savingsTier(p)]))).toEqual({
      'aave-v3-arbitrum-sepolia': 'stable',
      'aave-v3-avalanche-fuji': 'stable',
      'aave-v3-arbitrum': 'stable',
      'fluid-fusdc-arbitrum': 'plus',
      'spark-susdc-arbitrum': 'stable',
      'aave-v3-avalanche': 'stable',
      'benqi-qiusdcn-avalanche': 'plus',
      'aave-v3-monad': 'plus',
      'euler-clearstar-monad': 'turbo',
      'morpho-august-monad': 'turbo',
    });
    // A DAO-governed vault whose loans rest on one collateral is plus, not stable.
    const aave = savingsProvider('aave-v3-arbitrum');
    if (aave.risk === 'testnet') throw new Error('sheet');
    expect(savingsTier({ ...aave, risk: { ...aave.risk, collateral: ['FXRP'] } })).toBe('plus');
    const testnets = new Set(Object.keys(walletNetworks));
    for (const { network, risk } of savingsProviders) {
      expect(risk === 'testnet').toBe(testnets.has(network));
      if (risk !== 'testnet') expect(risk.audits.length).toBeGreaterThan(0);
    }
  });

  it('approve exactly the amount and deposit it for the account, whatever the kind', () => {
    const aave = savingsProvider('aave-v3-arbitrum');
    const vault = savingsProvider('fluid-fusdc-arbitrum');
    const compound = savingsProvider('benqi-qiusdcn-avalanche');
    for (const provider of [aave, vault, compound]) {
      const [approve, deposit] = depositCalls(provider, account, 7_000_000n);
      expect(approve.to).toBe(provider.asset);
      expect(decodeApprove(approve).args?.[1]).toBe(7_000_000n);
      expect(decodeApprove(approve).args?.[0]).toBe(deposit.to);
    }
    expect(decode(depositCalls(aave, account, 1n)[1]).args).toEqual([aave.asset, 1n, account, 0]);
    expect(decode(depositCalls(vault, account, 1n)[1]).args).toEqual([1n, account]);
    expect(decode(depositCalls(compound, account, 1n)[1]).functionName).toBe('mint');
    expect(() => depositCalls(aave, account, 0n)).toThrow('INVALID_AMOUNT');
  });

  it('withdraw an amount, or every share of the position', () => {
    const held = { account, shares: 123n, assets: 456n };
    const aave = savingsProvider('aave-v3-arbitrum');
    expect(decode(withdrawCalls(aave, held, 'all')[0]).args).toEqual([
      aave.asset,
      maxUint256,
      account,
    ]);
    const vault = savingsProvider('morpho-august-monad');
    expect(decode(withdrawCalls(vault, held, 'all')[0])).toMatchObject({
      functionName: 'redeem',
      args: [123n, account, account],
    });
    expect(decode(withdrawCalls(vault, held, 5n)[0])).toMatchObject({
      functionName: 'withdraw',
      args: [5n, account, account],
    });
    const compound = savingsProvider('benqi-qiusdcn-avalanche');
    expect(decode(withdrawCalls(compound, held, 'all')[0])).toMatchObject({
      functionName: 'redeem',
      args: [123n],
    });
    expect(decode(withdrawCalls(compound, held, 5n)[0]).functionName).toBe('redeemUnderlying');
  });

  it('turn two growth readings into the yearly rate they imply', () => {
    const start = { index: 10n ** 27n, at: 0 };
    expect(realizedRate(start, { index: (10n ** 27n * 105n) / 100n, at: 31_536_000 })).toBeCloseTo(
      0.05,
      9,
    );
    // 1 % in a quarter of a year compounds to about 4.06 % a year.
    expect(
      realizedRate(start, { index: (10n ** 27n * 101n) / 100n, at: 31_536_000 / 4 }),
    ).toBeCloseTo(0.0406, 4);
    expect(realizedRate(start, { index: (10n ** 27n * 99n) / 100n, at: 31_536_000 })).toBeLessThan(
      0,
    );
    expect(() => realizedRate(start, start)).toThrow('INVALID_READINGS');
  });
});

const USDC = 10n ** 6n;
const DAY = 86_400;

/**
 * Each mainnet with its real contracts, through RPCs that serve past state: a fork reads at its
 * starting block, which is soon too old for pruned nodes (Arbitrum makes four blocks a second).
 * Every provider of the network gets the same cycle: deposit, withdraw part, earn for 30 days,
 * withdraw everything.
 */
const forks: { name: string; network: string; chain: Chain; rpc: string }[] = [
  {
    name: 'Arbitrum One',
    network: 'eip155:42161',
    chain: arbitrum,
    rpc: process.env.ARBITRUM_RPC ?? 'https://arbitrum-one.public.blastapi.io',
  },
  {
    name: 'Avalanche',
    network: 'eip155:43114',
    chain: avalanche,
    rpc: process.env.AVALANCHE_RPC ?? 'https://api.avax.network/ext/bc/C/rpc',
  },
  {
    name: 'Monad',
    network: 'eip155:143',
    chain: monad,
    rpc: process.env.MONAD_RPC ?? 'https://rpc.monad.xyz',
  },
];

for (const fork of forks) {
  const providers: SavingsProvider[] = savingsProviders.filter(
    ({ network }) => network === fork.network,
  );

  describe(`savings on a ${fork.name} fork`, { timeout: 120_000 }, () => {
    const forkClient = (url: string) =>
      createTestClient({
        chain: fork.chain,
        mode: 'anvil',
        transport: http(url, { timeout: 60_000 }),
      })
        .extend(publicActions)
        .extend(walletActions);
    let node: Awaited<ReturnType<typeof startFork>> | undefined;
    let client: ReturnType<typeof forkClient>;
    let reader: PublicClient;

    beforeAll(async () => {
      node = await startFork(fork.rpc);
      client = forkClient(node.url);
      reader = client as unknown as PublicClient;
    }, 120_000);
    afterAll(() => node?.stop());

    /** A fresh holder per provider, with gas and `amount` USDC. */
    const holder = async (provider: SavingsProvider, amount: bigint): Promise<Address> => {
      const index = savingsProviders.findIndex(({ id }) => id === provider.id);
      const address = `0x${(0xa11ce00 + index).toString(16).padStart(40, '0')}` as Address;
      await client.setBalance({ address, value: 10n ** 20n });
      await client.impersonateAccount({ address });
      await deal(provider.asset, address, amount);
      return address;
    };
    const deal = (token: Address, owner: Address, amount: bigint) =>
      client.request({
        method: 'anvil_dealERC20' as 'anvil_setBalance',
        params: [owner, token, `0x${amount.toString(16)}`] as never,
      });
    const usdcOf = (provider: SavingsProvider, owner: Address) =>
      client.readContract({
        address: provider.asset,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });
    /** Sends the calls one by one from `from`, as the account's batch would. */
    const run = async (from: Address, calls: SavingsCall[]) => {
      for (const call of calls) {
        const hash = await client.sendTransaction({
          account: from,
          chain: fork.chain,
          to: call.to,
          data: call.data,
          // eth_estimateGas leaves Aave's withdrawal a few thousand short on these forks, and its
          // health-factor check runs out of gas under the 63/64 rule.
          gas: 3_000_000n,
        });
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error(`REVERTED: ${call.to}`);
      }
    };

    it.each(providers.map((provider) => [provider.id, provider] as const))(
      '%s: deposit, withdraw part, earn, withdraw everything',
      async (_, provider) => {
        const owner = await holder(provider, 1_000n * USDC);
        await run(owner, depositCalls(provider, owner, 1_000n * USDC));
        expect(await usdcOf(provider, owner)).toBe(0n);
        const deposited = await position(reader, provider, owner);
        // Rounding in the provider's favour costs at most a few units.
        expect(deposited.assets).toBeGreaterThanOrEqual(1_000n * USDC - 2n);
        expect(deposited.assets).toBeLessThanOrEqual(1_000n * USDC);
        expect(await withdrawable(reader, provider, owner)).toBe(deposited.assets);

        await run(owner, withdrawCalls(provider, deposited, 400n * USDC));
        expect(await usdcOf(provider, owner)).toBe(400n * USDC);

        const before = { index: await growthIndex(reader, provider), at: 0 };
        await client.increaseTime({ seconds: 30 * DAY });
        await client.mine({ blocks: 1 });
        const after = { index: await growthIndex(reader, provider), at: 30 * DAY };
        const rate = realizedRate(before, after);
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThan(0.5);

        const held = await position(reader, provider, owner);
        await run(owner, withdrawCalls(provider, held, 'all'));
        expect((await position(reader, provider, owner)).shares).toBe(0n);
        expect(await usdcOf(provider, owner)).toBeGreaterThanOrEqual(1_000n * USDC - 2n);
      },
    );

    if (fork.network === 'eip155:42161')
      it('Aave pays out only what is not lent, and a larger withdrawal reverts', async () => {
        const provider = savingsProvider('aave-v3-arbitrum');
        if (provider.kind !== 'aave-v3') throw new Error('kind');
        const owner = await holder(provider, 1_000n * USDC);
        await run(owner, depositCalls(provider, owner, 1_000n * USDC));
        // Everyone else borrowed the market dry: 10 USDC are left in the aToken.
        await deal(provider.asset, provider.aToken, 10n * USDC);
        expect(await withdrawable(reader, provider, owner)).toBe(10n * USDC);
        const held = await position(reader, provider, owner);
        await expect(run(owner, withdrawCalls(provider, held, 11n * USDC))).rejects.toThrow();
        await run(owner, withdrawCalls(provider, held, 10n * USDC));
        expect(await usdcOf(provider, owner)).toBe(10n * USDC);
      });

    if (fork.network === 'eip155:43114')
      it('BENQI refuses without reverting, and a loss shows in the index and the position', async () => {
        const provider = savingsProvider('benqi-qiusdcn-avalanche');
        if (provider.kind !== 'compound-v2') throw new Error('kind');
        const owner = await holder(provider, 1_000n * USDC);
        await run(owner, depositCalls(provider, owner, 1_000n * USDC));
        const cash = await usdcOf(provider, provider.market);
        await deal(provider.asset, provider.market, 10n * USDC);
        expect(await withdrawable(reader, provider, owner)).toBe(10n * USDC);
        // The market lacks the cash: the call succeeds, returns an error code and pays nothing.
        const held = await position(reader, provider, owner);
        await run(owner, withdrawCalls(provider, held, 11n * USDC));
        expect(await usdcOf(provider, owner)).toBe(0n);
        expect((await position(reader, provider, owner)).shares).toBe(held.shares);

        // Losing a tenth of its cash lowers what every share is worth.
        await deal(provider.asset, provider.market, cash);
        const restored = await position(reader, provider, owner);
        const before = { index: await growthIndex(reader, provider), at: 0 };
        await deal(provider.asset, provider.market, (cash * 9n) / 10n);
        const after = { index: await growthIndex(reader, provider), at: DAY };
        expect(after.index).toBeLessThan(before.index);
        expect(realizedRate(before, after)).toBeLessThan(0);
        expect((await position(reader, provider, owner)).assets).toBeLessThan(restored.assets);
      });

    if (fork.network === 'eip155:143')
      it('Morpho V2: what can leave is exactly what a withdrawal can take', async () => {
        const provider = savingsProvider('morpho-august-monad');
        if (provider.kind !== 'morpho-v2') throw new Error('kind');
        const owner = await holder(provider, 1_000n * USDC);
        await run(owner, depositCalls(provider, owner, 1_000n * USDC));
        // Someone borrows the vault's liquidity market down to 100 USDC (earnAUSD as collateral).
        const [adapter, data] = await Promise.all([
          client.readContract({
            address: provider.vault,
            abi: morpho,
            functionName: 'liquidityAdapter',
          }),
          client.readContract({
            address: provider.vault,
            abi: morpho,
            functionName: 'liquidityData',
          }),
        ]);
        const blue = await client.readContract({
          address: adapter,
          abi: morpho,
          functionName: 'morpho',
        });
        const [params] = decodeAbiParameters(marketParams, data);
        const id = keccak256(encodeAbiParameters(marketParams, [params]));
        const borrower: Address = '0x000000000000000000000000000000000b0770e1';
        await client.setBalance({ address: borrower, value: 10n ** 20n });
        await client.impersonateAccount({ address: borrower });
        await deal(params.collateralToken, borrower, 10n ** 14n);
        await run(borrower, [
          {
            to: params.collateralToken,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [blue, maxUint256],
            }),
          },
          {
            to: blue,
            data: encodeFunctionData({
              abi: morpho,
              functionName: 'supplyCollateral',
              args: [params, 10n ** 14n, borrower, '0x'],
            }),
          },
        ]);
        const [supplied, , borrowed] = await client.readContract({
          address: blue,
          abi: morpho,
          functionName: 'market',
          args: [id],
        });
        await run(borrower, [
          {
            to: blue,
            data: encodeFunctionData({
              abi: morpho,
              functionName: 'borrow',
              args: [params, supplied - borrowed - 100n * USDC, 0n, borrower, borrower],
            }),
          },
        ]);

        const held = await position(reader, provider, owner);
        const available = await withdrawable(reader, provider, owner);
        expect(available).toBeLessThan(held.assets);
        expect(available).toBeGreaterThanOrEqual(99n * USDC);
        await expect(run(owner, withdrawCalls(provider, held, available + USDC))).rejects.toThrow();
        await run(owner, withdrawCalls(provider, held, available));
        expect(await usdcOf(provider, owner)).toBe(available);
      });
  });
}
