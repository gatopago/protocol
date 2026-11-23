import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  concatHex,
  createTestClient,
  encodeAbiParameters,
  erc20Abi,
  getContractAddress,
  http,
  keccak256,
  numberToHex,
  parseAbi,
  parseEventLogs,
  publicActions,
  toBytes,
  walletActions,
  type Address,
  type Hex,
} from 'viem';
import { avalancheFuji } from 'viem/chains';
import {
  depositAbi,
  depositAddress,
  depositContracts,
  depositFactoryAbi,
  depositSalt,
  type DepositSettlement,
} from '../packages/shared/deposits';
import { walletNetworks } from '../packages/shared/networks';
import { startFork } from './anvil';

const CREATE2_DEPLOYER: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const SALT = keccak256(toBytes('cascabel.deposits.v1')); // DeployDeposits.s.sol
const fuji = walletNetworks['eip155:43113'];
const ARBITRUM_DOMAIN = walletNetworks['eip155:421614'].cctp.domain;

const factoryCode = (): Hex =>
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        '../contracts/out/CascabelDepositFactory.sol/CascabelDepositFactory.json',
      ),
      'utf8',
    ),
  ).bytecode.object;

describe('Cascabel deposit addresses', () => {
  it('match what DeployDeposits.s.sol deploys from the compiled contracts', () => {
    const factory = getContractAddress({
      opcode: 'CREATE2',
      from: CREATE2_DEPLOYER,
      salt: SALT,
      bytecode: factoryCode(),
    });
    expect(factory).toBe(depositContracts.factory);
    // The factory creates the implementation in its constructor, its first creation.
    expect(getContractAddress({ from: factory, nonce: 1n })).toBe(depositContracts.implementation);
  });

  it('change with the charge and with where its funds go', () => {
    const settlement: DepositSettlement = {
      recipient: '0x00000000000000000000000000000000000000c1',
      destinationDomain: 3,
      maxFee: 200_000n,
      localRecipient: '0x00000000000000000000000000000000000000c1',
    };
    const deposit = depositAddress(depositSalt('pi_1'), settlement);
    expect(depositAddress(depositSalt('pi_2'), settlement)).not.toBe(deposit);
    expect(depositAddress(depositSalt('pi_1'), { ...settlement, destinationDomain: 1 })).not.toBe(
      deposit,
    );
  });
});

// Each test reads Circle's contracts through the fork for the first time: seconds, not milliseconds.
describe(
  'Cascabel deposits on an Avalanche Fuji fork, with Circle USDC and CCTP',
  { timeout: 60_000 },
  () => {
    const forkClient = (url: string) =>
      createTestClient({ chain: avalancheFuji, mode: 'anvil', transport: http(url) })
        .extend(publicActions)
        .extend(walletActions);
    let fork: Awaited<ReturnType<typeof startFork>> | undefined;
    let client: ReturnType<typeof forkClient>;
    const sweeper: Address = '0x00000000000000000000000000000000000000d0';
    const treasury: Address = '0x000000000000000000000000000000000000a11c';
    const localTreasury: Address = '0x000000000000000000000000000000000000b0b0';

    beforeAll(async () => {
      fork = await startFork(
        // Avalanche's own public RPC answers 500 to the state reads a fork makes.
        process.env.FUJI_RPC ?? 'https://avalanche-fuji-c-chain-rpc.publicnode.com',
      );
      client = forkClient(fork.url);
      await client.setBalance({ address: sweeper, value: 10n ** 19n });
      await client.impersonateAccount({ address: sweeper });
      // As DeployDeposits.s.sol does: through the standard CREATE2 deployer.
      await client.sendTransaction({
        account: sweeper,
        chain: avalancheFuji,
        to: CREATE2_DEPLOYER,
        data: concatHex([SALT, factoryCode()]),
      });
    }, 120_000);
    afterAll(() => fork?.stop());

    /** Circle's FiatToken keeps balances in a mapping at slot 9 (`balanceAndBlacklistStates`). */
    const giveUsdc = async (owner: Address, amount: bigint) => {
      const slot = keccak256(
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, 9n]),
      );
      await client.setStorageAt({
        address: fuji.usdc,
        index: slot,
        value: numberToHex(amount, { size: 32 }),
      });
      expect(await usdcOf(owner)).toBe(amount);
    };
    const usdcOf = (owner: Address) =>
      client.readContract({
        address: fuji.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });
    const sweep = async (salt: Hex, settlement: DepositSettlement) => {
      const hash = await client.writeContract({
        account: sweeper,
        chain: avalancheFuji,
        address: depositContracts.factory,
        abi: depositFactoryAbi,
        functionName: 'sweep',
        args: [salt, settlement, fuji.usdc],
      });
      return client.waitForTransactionReceipt({ hash });
    };

    it('computes the address the factory derives, and pays the treasury on this network', async () => {
      const salt = depositSalt('pi_fuji_local');
      const settlement: DepositSettlement = {
        recipient: treasury,
        destinationDomain: fuji.cctp.domain,
        maxFee: 500_000n,
        localRecipient: localTreasury,
      };
      const deposit = depositAddress(salt, settlement);
      expect(
        await client.readContract({
          address: depositContracts.factory,
          abi: depositFactoryAbi,
          functionName: 'depositAddress',
          args: [salt, settlement],
        }),
      ).toBe(deposit);

      await giveUsdc(deposit, 25_000_000n);
      const receipt = await sweep(salt, settlement);

      expect(receipt.status).toBe('success');
      expect(await usdcOf(treasury)).toBe(25_000_000n);
      expect(await usdcOf(deposit)).toBe(0n);
    });

    it('burns with Circle CCTP toward the treasury on another network', async () => {
      const salt = depositSalt('pi_fuji_to_arbitrum');
      const settlement: DepositSettlement = {
        recipient: treasury,
        destinationDomain: ARBITRUM_DOMAIN,
        maxFee: 500_000n,
        localRecipient: localTreasury,
      };
      const deposit = depositAddress(salt, settlement);
      await giveUsdc(deposit, 25_000_000n);

      const receipt = await sweep(salt, settlement);

      expect(receipt.status).toBe('success');
      expect(await usdcOf(deposit)).toBe(0n);
      const [swept] = parseEventLogs({ abi: depositAbi, logs: receipt.logs, eventName: 'Swept' });
      expect(swept.args).toMatchObject({
        token: fuji.usdc,
        to: treasury,
        amount: 25_000_000n,
        crossed: true,
      });
      // Circle's own record of the burn: the treasury, on Arbitrum, is who it mints to.
      const [burn] = parseEventLogs({
        abi: parseAbi([
          'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
        ]),
        logs: receipt.logs,
      });
      expect(burn.args.depositor.toLowerCase()).toBe(deposit.toLowerCase());
      expect(burn.args.destinationDomain).toBe(ARBITRUM_DOMAIN);
      expect(burn.args.mintRecipient).toBe(encodeAbiParameters([{ type: 'address' }], [treasury]));
      expect(burn.args.maxFee).toBe(settlement.maxFee);
    });
  },
);
