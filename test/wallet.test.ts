import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  toHex,
  zeroHash,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  createBundlerClient,
  entryPoint09Address,
  getUserOperationHash,
  type UserOperation,
  type WebAuthnAccount,
} from 'viem/account-abstraction';
import { arbitrumSepolia, avalancheFuji } from 'viem/chains';
import { createSiweMessage, generateSiweNonce, verifySiweMessage } from 'viem/siwe';
import {
  REPLAYABLE_NONCE_KEY,
  encodeApplyApproval,
  gatopagoAccountAbi,
  gatopagoAccountFactoryAbi,
  keyOwner,
  messageSigner,
  passkeyOwner,
  signApproval,
  sponsorshipPaymasterData,
  ownersAfter,
  verifiedOwners,
  verifyApproval,
  sponsorshipTypedData,
  toGatoPagoAccount,
  type GatoPagoAccount,
  type WalletContracts,
} from '../packages/shared/wallet';
import { bundlerJsonRpc, createBundler, gatopagoGasConfig } from '../packages/shared/bundler';
import { crosschainCalls } from '../packages/shared/crosschain';
import { depositCalls, withdrawCalls } from '../packages/shared/earn';
import { payFromSavingsCalls, payoutCalls, splitCalls } from '../packages/shared/rules';
import { minimumOut, quoteSwap, swapCalls } from '../packages/shared/swap';
import { walletNetworks } from '../packages/shared/networks';
import { findAccount, type AccountApprovals } from '../packages/shared/passkey';
import { passkeyAssertion, softwarePasskey } from './passkey';
import {
  paymentCalls,
  paymentPermit,
  paymentRouterAbi,
  paymentTypedData,
  payWithPermitCall,
} from '../packages/shared/payments';

/**
 * Forks of real networks with GatoPago contracts deployed through the standard CREATE2 deployer
 * (present on Arbitrum, Avalanche and Monad) so they share addresses, as in production. The Osaka
 * hardfork provides the P256 precompile those networks have; the third fork lacks it on purpose.
 */
const ARBITRUM_SEPOLIA_RPC =
  process.env.ARBITRUM_SEPOLIA_RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const NETWORKS = [
  { chain: arbitrumSepolia, fork: ARBITRUM_SEPOLIA_RPC, port: 8611, p256: true },
  {
    chain: avalancheFuji,
    fork: process.env.AVALANCHE_FUJI_RPC ?? 'https://api.avax-test.network/ext/bc/C/rpc',
    port: 8621,
    p256: true,
  },
  { chain: arbitrumSepolia, fork: ARBITRUM_SEPOLIA_RPC, port: 8631, p256: false },
] as const;
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const relayerKey = '0xac0974bec39a17e36ba4a846b8f9e6d0f2a4cf0b8ba3c9ec2a1fe8a7d6a5f1a7' as const;
const relayer = privateKeyToAccount(relayerKey);
const sponsor = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const merchant = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
).address;

function artifact(name: string) {
  const json = JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../contracts/out/${name}.sol/${name}.json`), 'utf8'),
  );
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
}

function network(chain: Chain, fork: string, port: number, p256: boolean) {
  const rpc = `http://127.0.0.1:${port}`;
  // Forks read remote state on first touch (a pool's ticks can take longer than viem's 10 s default).
  const publicClient = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000 }) });
  const walletClient = createWalletClient({ chain, transport: http(rpc), account: relayer });
  const hardfork = p256 ? ['--hardfork', 'osaka'] : [];
  const anvil: ChildProcess = spawn(
    'anvil',
    ['--fork-url', fork, '--port', String(port), ...hardfork, '--silent'],
    {
      stdio: 'ignore',
    },
  );
  let server: Server | undefined;
  const storage = new Map<string, unknown>();
  let bundler: ReturnType<typeof createBundler> | undefined;
  /** Between the bundler and the node: can lose the next broadcast (request or response). */
  let loseNextBroadcast: 'request' | 'response' | undefined;
  const proxy = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const loss =
      JSON.parse(body).method === 'eth_sendRawTransaction' ? loseNextBroadcast : undefined;
    if (loss) loseNextBroadcast = undefined;
    const forwarded =
      loss === 'request'
        ? undefined
        : await (
            await fetch(rpc, {
              method: 'POST',
              body,
              headers: { 'Content-Type': 'application/json' },
            })
          ).text();
    response.setHeader('Content-Type', 'application/json');
    response.end(
      loss
        ? JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32000, message: 'connection lost' },
          })
        : forwarded,
    );
  });
  return {
    chain,
    publicClient,
    walletClient,
    storage,
    bundler: () => bundler!,
    bundlerUrl: `http://127.0.0.1:${port + 1}`,
    loseNextBroadcast(part: 'request' | 'response') {
      loseNextBroadcast = part;
    },
    async rpc(method: string, params: unknown[] = []) {
      return publicClient.request({ method: method as never, params: params as never });
    },
    async start() {
      for (let i = 0; ; i++) {
        try {
          await publicClient.getChainId();
          break;
        } catch (error) {
          if (i > 150) throw error;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      await publicClient.request({
        method: 'anvil_setBalance' as never,
        params: [relayer.address, toHex(10n ** 21n)] as never,
      });
    },
    async deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
      const { abi, bytecode } = artifact(name);
      const initCode = encodeDeployData({ abi, bytecode, args });
      const address = getContractAddress({
        opcode: 'CREATE2',
        from: CREATE2_DEPLOYER,
        salt: zeroHash,
        bytecode: initCode,
      });
      if (!(await publicClient.getCode({ address }))) {
        const hash = await walletClient.sendTransaction({
          to: CREATE2_DEPLOYER,
          data: concat([zeroHash, initCode]),
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }
      return address;
    },
    async write(
      address: Address,
      abi: Abi,
      functionName: string,
      args: readonly unknown[] = [],
      value?: bigint,
    ) {
      const hash = await walletClient.writeContract({
        address,
        abi,
        functionName,
        args,
        value,
      } as never);
      await publicClient.waitForTransactionReceipt({ hash });
    },
    async serveBundler(paymaster: Address) {
      await new Promise<void>((done) => proxy.listen(port + 2, done));
      bundler = createBundler({
        chain,
        rpcUrl: `http://127.0.0.1:${port + 2}`,
        relayerKey,
        paymaster,
        gas: gatopagoGasConfig,
        store: {
          get: async <T>(key: string) => storage.get(key) as T | undefined,
          put: async (entries) => {
            for (const [key, value] of Object.entries(entries)) storage.set(key, value);
          },
          delete: async (keys) => keys.filter((key) => storage.delete(key)).length,
        },
      });
      server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(await bundlerJsonRpc(bundler!, JSON.parse(body))));
      });
      await new Promise<void>((done) => server!.listen(port + 1, done));
    },
    stop() {
      server?.close();
      proxy.close();
      anvil.kill();
    },
  };
}
type Network = ReturnType<typeof network>;

const networks: Network[] = NETWORKS.map((n) => network(n.chain, n.fork, n.port, n.p256));
const [arbitrum, fuji, withoutP256] = networks;
let contracts: WalletContracts;
let usdc: Address;

beforeAll(async () => {
  const deployed = await Promise.all(
    networks.map(async (n) => {
      await n.start();
      const result = {
        webAuthnVerifier: await n.deploy('ERC7913WebAuthnVerifier'),
        factory: await n.deploy('GatoPagoAccountFactory'),
        paymaster: await n.deploy('GatoPagoPaymaster', [sponsor.address, relayer.address]),
        usdc: await n.deploy('ERC20Mock'),
      };
      await n.write(result.paymaster, artifact('GatoPagoPaymaster').abi, 'deposit', [], 10n ** 18n);
      await n.serveBundler(result.paymaster);
      return result;
    }),
  );
  for (const addresses of deployed) expect(addresses).toEqual(deployed[0]);
  ({ usdc, ...contracts } = deployed[0]);
}, 180_000);

afterAll(() => networks.forEach((n) => n.stop()));

/** What the backend's ERC-7677 endpoint does: sign sponsorship for the final gas values, per network. */
const paymasterGas = {
  paymasterVerificationGasLimit: gatopagoGasConfig.paymasterVerificationGasLimit,
  paymasterPostOpGasLimit: gatopagoGasConfig.paymasterPostOpGasLimit,
};
const sponsorship = {
  async getPaymasterStubData() {
    return {
      paymaster: contracts.paymaster,
      paymasterData: sponsorshipPaymasterData(0, 0, `0x${'00'.repeat(65)}`),
      ...paymasterGas,
    };
  },
  async getPaymasterData(operation: UserOperation<'0.9'> & { chainId: number }) {
    const validUntil = Math.floor(Date.now() / 1000) + 3600;
    const signature = await sponsor.signTypedData(
      sponsorshipTypedData({
        chainId: operation.chainId,
        paymaster: contracts.paymaster,
        userOperation: { ...operation, ...paymasterGas },
        validAfter: 0,
        validUntil,
      }),
    );
    return {
      paymaster: contracts.paymaster,
      paymasterData: sponsorshipPaymasterData(0, validUntil, signature),
      ...paymasterGas,
    };
  },
};

async function send(
  on: Network,
  account: GatoPagoAccount,
  operation:
    | { calls: readonly { to: Address; data: Hex }[] }
    | { callData: Hex; nonce: bigint; signature: Hex },
) {
  const bundlerClient = createBundlerClient({
    account,
    client: on.publicClient,
    paymaster: sponsorship as never,
    transport: http(on.bundlerUrl),
  });
  const hash = await bundlerClient.sendUserOperation(operation as never);
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash });
  expect(receipt.success).toBe(true);
  // Estimated limits: the gas charged to the operation covers the relayer's transaction,
  // without paying for unused call gas or a fixed preVerificationGas.
  expect(receipt.actualGasUsed).toBeGreaterThanOrEqual(receipt.receipt.gasUsed);
  expect(receipt.actualGasUsed).toBeLessThan((receipt.receipt.gasUsed * 115n) / 100n);
}

const depositForBurnAbi = parseAbi([
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
]);

const transfer = (amount: bigint) => ({
  to: usdc,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [merchant, amount] }),
});
const balance = (on: Network, owner: Address) =>
  on.publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
const mint = (on: Network, to: Address) =>
  on.write(usdc, artifact('ERC20Mock').abi, 'mint', [to, 100_000_000n]);

/** Circle's USDC on the Arbitrum Sepolia fork, from Aave's aUSDC reserve. */
async function fundWithCircleUsdc(to: Address, amount: bigint) {
  const holder = '0x460b97bd498e1157530aeb3086301d5225b91216';
  await arbitrum.rpc('anvil_impersonateAccount', [holder]);
  await arbitrum.rpc('anvil_setBalance', [holder, toHex(10n ** 18n)]);
  const hash = await arbitrum.walletClient.writeContract({
    account: holder,
    address: walletNetworks['eip155:421614'].usdc,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
  } as never);
  await arbitrum.publicClient.waitForTransactionReceipt({ hash });
}

describe('GatoPago account through viem and the GatoPago bundler', () => {
  it('pays without ETH, then a backup passkey recovers it on a network where it never existed', async () => {
    const phone = softwarePasskey();
    const laptop = softwarePasskey();
    const [arbitrumBefore, fujiBefore] = [
      await balance(arbitrum, merchant),
      await balance(fuji, merchant),
    ];

    // Arbitrum: a new passkey account receives USDC and pays without holding ETH.
    const onArbitrum = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: phone,
      contracts,
    });
    await mint(arbitrum, onArbitrum.address);
    expect(await arbitrum.publicClient.getCode({ address: onArbitrum.address })).toBeUndefined();
    await send(arbitrum, onArbitrum, { calls: [transfer(25_000_000n)] });
    expect(await arbitrum.publicClient.getBalance({ address: onArbitrum.address })).toBe(0n);

    // The phone approves the laptop once, through the replayable channel.
    const addLaptop = encodeFunctionData({
      abi: gatopagoAccountAbi,
      functionName: 'addOwners',
      args: [[passkeyOwner(contracts.webAuthnVerifier, laptop.publicKey)]],
    });
    const approval = await signApproval(onArbitrum, 0n, addLaptop);
    await send(arbitrum, onArbitrum, {
      callData: encodeApplyApproval(0n, addLaptop),
      nonce: await onArbitrum.getNonce({ key: REPLAYABLE_NONCE_KEY }),
      signature: approval,
    });

    // The phone is lost. On Avalanche the account was never deployed.
    const onFuji = await toGatoPagoAccount({
      client: fuji.publicClient,
      owner: laptop,
      contracts,
      initialOwners: onArbitrum.initialOwners,
    });
    expect(onFuji.address).toBe(onArbitrum.address);
    expect(await fuji.publicClient.getCode({ address: onFuji.address })).toBeUndefined();
    await mint(fuji, onFuji.address);

    await send(fuji, onFuji, {
      callData: encodeApplyApproval(0n, addLaptop),
      nonce: await onFuji.getNonce({ key: REPLAYABLE_NONCE_KEY }),
      signature: approval,
    });
    await send(fuji, onFuji, { calls: [transfer(5_000_000n)] });

    expect((await balance(arbitrum, merchant)) - arbitrumBefore).toBe(25_000_000n);
    expect((await balance(fuji, merchant)) - fujiBefore).toBe(5_000_000n);
    expect(await fuji.publicClient.getBalance({ address: onFuji.address })).toBe(0n);
  }, 180_000);

  it('moves real USDC to another network through CCTP in one operation', async () => {
    const [from, to] = [walletNetworks['eip155:421614'], walletNetworks['eip155:43113']];
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: softwarePasskey(),
      contracts,
    });
    await fundWithCircleUsdc(account.address, 10_000_000n);

    const calls = crosschainCalls({
      from,
      to,
      amount: 10_000_000n,
      recipient: merchant,
      maxFee: 300_000n,
    });
    const bundlerClient = createBundlerClient({
      account,
      client: arbitrum.publicClient,
      paymaster: sponsorship as never,
      transport: http(arbitrum.bundlerUrl),
    });
    const hash = await bundlerClient.sendUserOperation({ calls });
    const { receipt, success } = await bundlerClient.waitForUserOperationReceipt({ hash });
    expect(success).toBe(true);
    const [burn] = parseEventLogs({ abi: depositForBurnAbi, logs: receipt.logs });
    expect(burn.args).toMatchObject({
      burnToken: getAddress(from.usdc),
      amount: 10_000_000n,
      depositor: account.address,
      mintRecipient: pad(merchant).toLowerCase(),
      destinationDomain: 1,
      maxFee: 300_000n,
      minFinalityThreshold: 1000,
    });
    expect(burn.args.hookData.startsWith(toHex('cctp-forward'))).toBe(true);
    expect(
      await arbitrum.publicClient.readContract({
        address: from.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      }),
    ).toBe(0n);
  }, 60_000);

  it('saves USDC in Aave and withdraws all of it', async () => {
    const network = walletNetworks['eip155:421614'];
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: softwarePasskey(),
      contracts,
    });
    await fundWithCircleUsdc(account.address, 10_000_000n);
    const read = (token: Address) =>
      arbitrum.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

    await send(arbitrum, account, { calls: depositCalls(network, account.address, 10_000_000n) });
    expect(await read(network.usdc)).toBe(0n);
    // aToken balances round to the liquidity index: within a unit of the deposit.
    expect(await read(network.aave.aToken)).toBeGreaterThanOrEqual(9_999_999n);

    await send(arbitrum, account, { calls: withdrawCalls(network, account.address, 'all') });
    expect(await read(network.aave.aToken)).toBe(0n);
    expect(await read(network.usdc)).toBeGreaterThanOrEqual(9_999_999n);
  }, 60_000);

  it('pays a team, splits income and pays from savings, each in one operation, all or nothing', async () => {
    const network = walletNetworks['eip155:421614'];
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: softwarePasskey(),
      contracts,
    });
    await fundWithCircleUsdc(account.address, 10_000_000n);
    const [ana, beto, caro] = [1, 2, 3].map(
      (i) => `0x${i.toString(16).padStart(2, '0').repeat(20)}` as Address,
    );
    const balance = (token: Address, owner: Address) =>
      arbitrum.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });

    await send(arbitrum, account, {
      calls: payoutCalls(network.usdc, [
        { to: ana, amount: 1_000_000n },
        { to: beto, amount: 2_000_000n },
      ]),
    });
    expect(await balance(network.usdc, ana)).toBe(1_000_000n);
    expect(await balance(network.usdc, beto)).toBe(2_000_000n);

    // 7 USDC arrived: 1 to the team, 4 saved, 2 stay available.
    await send(arbitrum, account, {
      calls: splitCalls(network, account.address, {
        payouts: [{ to: caro, amount: 1_000_000n }],
        save: 4_000_000n,
      }),
    });
    expect(await balance(network.usdc, account.address)).toBe(2_000_000n);
    expect(await balance(network.aave.aToken, account.address)).toBeGreaterThanOrEqual(3_999_999n);

    // Paying from savings withdraws exactly the payouts: what was available stays untouched.
    await send(arbitrum, account, {
      calls: payFromSavingsCalls(network, account.address, [
        { to: ana, amount: 500_000n },
        { to: caro, amount: 1_500_000n },
      ]),
    });
    expect(await balance(network.usdc, ana)).toBe(1_500_000n);
    expect(await balance(network.usdc, caro)).toBe(2_500_000n);
    expect(await balance(network.usdc, account.address)).toBe(2_000_000n);
    expect(await balance(network.aave.aToken, account.address)).toBeGreaterThanOrEqual(1_999_998n);

    // A payout the account cannot cover in the middle fails as a whole: the first one does not go.
    const bundlerClient = createBundlerClient({
      account,
      client: arbitrum.publicClient,
      paymaster: sponsorship as never,
      transport: http(arbitrum.bundlerUrl),
    });
    await expect(
      bundlerClient.sendUserOperation({
        calls: payoutCalls(network.usdc, [
          { to: beto, amount: 1_000_000n },
          { to: caro, amount: 50_000_000n },
        ]),
      }),
    ).rejects.toThrow();
    expect(await balance(network.usdc, beto)).toBe(2_000_000n);
    expect(await balance(network.usdc, account.address)).toBe(2_000_000n);
  }, 120_000);

  // Slow: the fork fetches the pools' tick data from the public RPC on first touch.
  it('swaps USDC for ETH and back through Uniswap in one operation each', async () => {
    const network = walletNetworks['eip155:421614'];
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: softwarePasskey(),
      contracts,
    });
    await fundWithCircleUsdc(account.address, 10_000_000n);
    const client = arbitrum.publicClient as never;
    const ether = () => arbitrum.publicClient.getBalance({ address: account.address });
    const dollars = () =>
      arbitrum.publicClient.readContract({
        address: network.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });

    const toEther = await quoteSwap(client, network, {
      tokenIn: 'usdc',
      tokenOut: 'native',
      amountIn: 10_000_000n,
    });
    expect(toEther.amountOut).toBeGreaterThan(0n);
    await send(arbitrum, account, {
      calls: swapCalls(network, account.address, toEther, minimumOut(toEther)),
    });
    expect(await dollars()).toBe(0n);
    const received = await ether();
    expect(received).toBeGreaterThanOrEqual(minimumOut(toEther));

    const toUsdc = await quoteSwap(client, network, {
      tokenIn: 'native',
      tokenOut: 'usdc',
      amountIn: received,
    });
    await send(arbitrum, account, {
      calls: swapCalls(network, account.address, toUsdc, minimumOut(toUsdc)),
    });
    expect(await ether()).toBe(0n);
    expect(await dollars()).toBeGreaterThanOrEqual(minimumOut(toUsdc));
  }, 300_000);

  it('pays a Flow payment intent through the router, locally and to another network', async () => {
    const home = walletNetworks['eip155:421614'];
    const flowSigner = privateKeyToAccount(
      '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    );
    const treasury = '0x000000000000000000000000000000000000fee5';
    const network = {
      ...home,
      paymentRouter: await arbitrum.deploy('GatoPagoPaymentRouter', [
        relayer.address,
        flowSigner.address,
        treasury,
        home.usdc,
        home.cctp.tokenMessenger,
        home.cctp.domain,
      ]),
    };
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: softwarePasskey(),
      contracts,
    });
    await fundWithCircleUsdc(account.address, 20_000_000n);
    const usdcOf = (owner: Address) =>
      arbitrum.publicClient.readContract({
        address: home.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });
    const bundlerClient = createBundlerClient({
      account,
      client: arbitrum.publicClient,
      paymaster: sponsorship as never,
      transport: http(arbitrum.bundlerUrl),
    });
    const pay = async (intent: string, destinationDomain: number) => {
      const payment = {
        intentId: keccak256(toHex(intent)),
        payer: account.address,
        merchant,
        amount: 5_000_000n,
        fee: 50_000n,
        destinationDomain,
        maxCctpFee: 300_000n,
        minFinalityThreshold: 1000,
        validUntil: Math.floor(Date.now() / 1000) + 3600,
      };
      const signature = await flowSigner.signTypedData(paymentTypedData(network, payment));
      const hash = await bundlerClient.sendUserOperation({
        calls: paymentCalls(network, payment, signature),
      });
      const { receipt, success } = await bundlerClient.waitForUserOperationReceipt({ hash });
      expect(success).toBe(true);
      return receipt;
    };

    const merchantBefore = await usdcOf(merchant);
    await pay('pi_local', home.cctp.domain);
    expect((await usdcOf(merchant)) - merchantBefore).toBe(5_000_000n);
    expect(await usdcOf(treasury)).toBe(50_000n);

    const receipt = await pay('pi_avalanche', 1);
    const [burn] = parseEventLogs({ abi: depositForBurnAbi, logs: receipt.logs });
    expect(burn.args).toMatchObject({
      amount: 5_300_000n,
      mintRecipient: pad(merchant).toLowerCase(),
      destinationDomain: 1,
      maxFee: 300_000n,
    });
    const [sent] = parseEventLogs({
      abi: paymentRouterAbi,
      logs: receipt.logs,
      eventName: 'PaymentSent',
    });
    expect(sent.args).toMatchObject({
      payer: account.address,
      amount: 5_000_000n,
      destinationDomain: 1,
    });
    // 20 USDC − (5 + 0.05) − (5 + 0.05 + 0.3)
    expect(await usdcOf(account.address)).toBe(9_600_000n);

    // A browser wallet signs a permit and pays in one transaction, leaving no allowance.
    const wallet = privateKeyToAccount(generatePrivateKey());
    await fundWithCircleUsdc(wallet.address, 6_000_000n);
    await arbitrum.rpc('anvil_setBalance', [wallet.address, toHex(10n ** 17n)]);
    const payment = {
      intentId: keccak256(toHex('pi_browser_wallet')),
      payer: wallet.address,
      merchant,
      amount: 5_000_000n,
      fee: 50_000n,
      destinationDomain: home.cctp.domain,
      maxCctpFee: 0n,
      minFinalityThreshold: 1000,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const permit = await wallet.signTypedData(
      await paymentPermit(arbitrum.publicClient, network, {
        owner: wallet.address,
        value: 5_050_000n,
        deadline,
      }),
    );
    const before = await usdcOf(merchant);
    const hash = await arbitrum.walletClient.sendTransaction({
      account: wallet,
      ...payWithPermitCall(
        network,
        payment,
        await flowSigner.signTypedData(paymentTypedData(network, payment)),
        { deadline, signature: permit },
      ),
    });
    expect((await arbitrum.publicClient.waitForTransactionReceipt({ hash })).status).toBe(
      'success',
    );
    expect((await usdcOf(merchant)) - before).toBe(5_000_000n);
    expect(await usdcOf(wallet.address)).toBe(950_000n);
    expect(
      await arbitrum.publicClient.readContract({
        address: home.usdc,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [wallet.address, network.paymentRouter],
      }),
    ).toBe(0n);
  }, 60_000);

  it('simulates a batch as a whole before the account exists (approve, then use the allowance)', async () => {
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: softwarePasskey(),
      contracts,
    });
    await mint(arbitrum, account.address);
    const before = await balance(arbitrum, merchant);
    const call = (functionName: 'approve' | 'transferFrom', args: readonly unknown[]) => ({
      to: usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName, args } as never),
    });
    await send(arbitrum, account, {
      calls: [
        call('approve', [account.address, 3_000_000n]),
        call('transferFrom', [account.address, merchant, 3_000_000n]),
      ],
    });
    expect((await balance(arbitrum, merchant)) - before).toBe(3_000_000n);
  }, 60_000);

  it('returns the recorded operation when a client resends it', async () => {
    const operation = await signedTransfer(1_000_000n);
    const hash = await operation.bundlerClient.sendUserOperation(operation.operation);
    await operation.bundlerClient.waitForUserOperationReceipt({ hash });
    expect(await operation.bundlerClient.sendUserOperation(operation.operation)).toBe(hash);
  }, 60_000);

  it('raises validation gas on a network without the P256 precompile', async () => {
    const account = await toGatoPagoAccount({
      client: withoutP256.publicClient,
      owner: softwarePasskey(),
      contracts,
    });
    await mint(withoutP256, account.address);
    await send(withoutP256, account, { calls: [transfer(1_000_000n)] });
  }, 60_000);

  it('signs in with SIWE through the account, before and after it is deployed', async () => {
    const phone = softwarePasskey();
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: phone,
      contracts,
    });
    const signIn = async (signer: GatoPagoAccount) => {
      const message = createSiweMessage({
        address: account.address,
        chainId: arbitrum.chain.id,
        domain: 'gatopago.com',
        nonce: generateSiweNonce(),
        uri: 'https://gatopago.com',
        version: '1',
      });
      return verifySiweMessage(arbitrum.publicClient, {
        message,
        signature: await signer.signMessage({ message }),
        domain: 'gatopago.com',
      });
    };

    expect(await signIn(account)).toBe(true); // ERC-6492: not deployed yet
    const stranger = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: softwarePasskey(),
      contracts,
      initialOwners: account.initialOwners,
    });
    expect(await signIn(stranger)).toBe(false);

    await mint(arbitrum, account.address);
    await send(arbitrum, account, { calls: [transfer(1_000_000n)] });
    expect(await signIn(account)).toBe(true); // ERC-1271
    expect(await signIn(stranger)).toBe(false);
  }, 60_000);

  it('lets a key derived from a passkey (Mera) own an account, pay sponsored and sign in', async () => {
    // Mera derives this key from the passkey's PRF output; any device with the passkey derives it again.
    const key = privateKeyToAccount(generatePrivateKey());
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: key,
      contracts,
    });
    expect(account.initialOwners).toEqual([keyOwner(key.address)]);
    await mint(arbitrum, account.address);
    const message = { raw: keccak256(toHex('gatopago.com sign-in')) };
    const valid = async () =>
      arbitrum.publicClient.verifyMessage({
        address: account.address,
        message,
        signature: await account.signMessage({ message }),
      });
    expect(await valid()).toBe(true); // ERC-6492, before the account exists
    await send(arbitrum, account, { calls: [transfer(1_000_000n)] });
    expect(await valid()).toBe(true); // ERC-1271
    const stranger = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: privateKeyToAccount(generatePrivateKey()),
      contracts,
      initialOwners: account.initialOwners,
    });
    expect(
      await arbitrum.publicClient.verifyMessage({
        address: account.address,
        message,
        signature: await stranger.signMessage({ message }),
      }),
    ).toBe(false);
  }, 60_000);

  it('costs less gas with a Mera key than with a passkey', async () => {
    const gasOf = async (owner: Parameters<typeof toGatoPagoAccount>[0]['owner']) => {
      const account = await toGatoPagoAccount({ client: arbitrum.publicClient, owner, contracts });
      await mint(arbitrum, account.address);
      const bundlerClient = createBundlerClient({
        account,
        client: arbitrum.publicClient,
        paymaster: sponsorship as never,
        transport: http(arbitrum.bundlerUrl),
      });
      // The second operation, once deployed: the steady cost of a payment.
      for (let i = 0; i < 2; i++) {
        const hash = await bundlerClient.sendUserOperation({ calls: [transfer(1_000_000n)] });
        const receipt = await bundlerClient.waitForUserOperationReceipt({ hash });
        if (i === 1) return receipt.actualGasUsed;
      }
      throw new Error('unreachable');
    };
    const passkey = await gasOf(softwarePasskey());
    const mera = await gasOf(privateKeyToAccount(generatePrivateKey()));
    // Measured on the Arbitrum Sepolia fork (P256 precompile): 163 299 vs 145 168. Without the
    // precompile the passkey's verification costs about 300 000 more.
    expect(mera).toBeLessThan(passkey);
  }, 120_000);

  it('verifies approvals before a server stores them for other networks', async () => {
    const phone = softwarePasskey();
    const laptop = softwarePasskey();
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: phone,
      contracts,
    });
    const onLaptop = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: laptop,
      contracts,
      initialOwners: account.initialOwners,
    });
    const addLaptop = encodeFunctionData({
      abi: gatopagoAccountAbi,
      functionName: 'addOwners',
      args: [[passkeyOwner(contracts.webAuthnVerifier, laptop.publicKey)]],
    });
    const removePhone = encodeFunctionData({
      abi: gatopagoAccountAbi,
      functionName: 'removeOwners',
      args: [[passkeyOwner(contracts.webAuthnVerifier, phone.publicKey)]],
    });
    const verify = (previous: Hex[], call: Hex, signature: Hex) =>
      verifyApproval(arbitrum.publicClient, {
        account: account.address,
        initialOwners: account.initialOwners,
        previous,
        call,
        signature,
      });

    const first = await signApproval(account, 0n, addLaptop);
    expect(await verify([], addLaptop, first)).toBe(
      passkeyOwner(contracts.webAuthnVerifier, phone.publicKey).toLowerCase(),
    );
    expect(await verify([], removePhone, first)).toBeNull(); // altered call
    expect(await verify([], addLaptop, await signApproval(onLaptop, 0n, addLaptop))).toBeNull(); // not an owner yet

    const second = await signApproval(onLaptop, 1n, removePhone);
    expect(await verify([addLaptop], removePhone, second)).toBe(
      passkeyOwner(contracts.webAuthnVerifier, laptop.publicKey).toLowerCase(),
    ); // the laptop is an owner after approval 0
    expect(await verify([], removePhone, second)).toBeNull(); // out of order

    // Who signed a message for the account, checked against the owners given: the phone, until
    // the owners no longer include it, whatever a lagging network would still accept.
    const signed = await account.signMessage({ message: 'sign in' });
    const signer = (owners: readonly Hex[]) =>
      messageSigner(arbitrum.publicClient, {
        account: account.address,
        owners,
        message: 'sign in',
        signature: signed,
      });
    expect(await signer(account.initialOwners)).toBe(account.initialOwners[0].toLowerCase());
    expect(await signer([passkeyOwner(contracts.webAuthnVerifier, laptop.publicKey)])).toBeNull();

    // A client rebuilds the owners from the history without trusting who served it.
    const history = [
      { sequence: 0, call: addLaptop, signature: first },
      { sequence: 1, call: removePhone, signature: second },
    ];
    const owners = (approvals: typeof history, initialOwners = account.initialOwners) =>
      verifiedOwners(arbitrum.publicClient, {
        factory: contracts.factory,
        account: account.address,
        initialOwners,
        approvals,
      });
    expect(await owners(history)).toEqual([
      passkeyOwner(contracts.webAuthnVerifier, laptop.publicKey).toLowerCase(),
    ]);
    // A server that slips in an owner no one approved, reorders, or lies about the initial owners.
    const intruder = encodeFunctionData({
      abi: gatopagoAccountAbi,
      functionName: 'addOwners',
      args: [[keyOwner(privateKeyToAccount(generatePrivateKey()).address)]],
    });
    await expect(
      owners([...history, { sequence: 2, call: intruder, signature: second }]),
    ).rejects.toThrow('APPROVALS_INVALID');
    await expect(owners([history[1], history[0]])).rejects.toThrow('APPROVALS_INVALID');
    await expect(
      owners(history, [passkeyOwner(contracts.webAuthnVerifier, laptop.publicKey)]),
    ).rejects.toThrow('APPROVALS_INVALID');

    // Signed by an owner, but the account would revert them and block every later approval.
    const impossible = async (call: Hex) => verify([], call, await signApproval(account, 0n, call));
    expect(await impossible(removePhone)).toBeNull(); // its last owner
    const addPhone = encodeFunctionData({
      abi: gatopagoAccountAbi,
      functionName: 'addOwners',
      args: [[passkeyOwner(contracts.webAuthnVerifier, phone.publicKey)]],
    });
    expect(await impossible(addPhone)).toBeNull(); // already an owner
    const upgrade = encodeFunctionData({
      abi: gatopagoAccountAbi,
      functionName: 'upgradeToAndCall',
      args: [contracts.factory, '0x'],
    });
    expect(await impossible(upgrade)).toBeNull(); // not an owner change
    // Owners derived from history stop where the account would.
    expect(ownersAfter(account.initialOwners, [removePhone, addLaptop])).toEqual(
      account.initialOwners.map((owner) => owner.toLowerCase()),
    );
  }, 60_000);

  it('finds the account a passkey opens by the verified owners of its Mera key', async () => {
    // A Mera account (its key the only initial owner) and its backup Mera key.
    const [mera, backupKey] = [
      privateKeyToAccount(generatePrivateKey()),
      privateKeyToAccount(generatePrivateKey()),
    ];
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: mera,
      contracts,
    });
    const addBackup = encodeFunctionData({
      abi: gatopagoAccountAbi,
      functionName: 'addOwners',
      args: [[keyOwner(backupKey.address)]],
    });
    const known = new Map<string, AccountApprovals>([
      [account.address.toLowerCase(), { initial_owners: null, approvals: [] }],
    ]);
    const lookup = {
      accountOf: (owners: readonly Hex[]) =>
        arbitrum.publicClient.readContract({
          address: contracts.factory,
          abi: gatopagoAccountFactoryAbi,
          functionName: 'getAddress',
          args: [owners, 0n],
        }),
      approvals: async (address: Address) => known.get(address.toLowerCase()) ?? null,
    };
    // The assertion only lends its user handle (and its signature, for older accounts).
    const find = async (owner: Address, handle?: Hex) =>
      findAccount(arbitrum.publicClient, {
        contracts,
        assertion: await passkeyAssertion(softwarePasskey(), handle),
        owner,
        lookup,
      });
    expect(await find(mera.address)).toEqual({
      address: account.address,
      initialOwners: [keyOwner(mera.address).toLowerCase()],
    });
    // The backup names the account in its user handle; it opens it once approved, not before.
    expect(await find(backupKey.address, account.address)).toBeNull();
    const approved = {
      sequence: 0,
      call: addBackup,
      signature: await signApproval(account, 0n, addBackup),
    };
    known.set(account.address.toLowerCase(), {
      initial_owners: account.initialOwners,
      approvals: [approved],
    });
    expect(await find(backupKey.address, account.address)).toMatchObject({
      address: account.address,
    });
    // An approval nobody signed does not make a key an owner, whatever the server says.
    const stranger = privateKeyToAccount(generatePrivateKey());
    const addStranger = encodeFunctionData({
      abi: gatopagoAccountAbi,
      functionName: 'addOwners',
      args: [[keyOwner(stranger.address)]],
    });
    known.set(account.address.toLowerCase(), {
      initial_owners: account.initialOwners,
      approvals: [approved, { sequence: 1, call: addStranger, signature: approved.signature }],
    });
    expect(await find(stranger.address, account.address)).toBeNull();

    // Wallet Core forgot the account (a reset database): the chain finds it for the key that
    // created it, not for a backup key, whose initial owners the chain does not tell.
    known.clear();
    const created = { address: account.address, initialOwners: account.initialOwners };
    expect(await find(mera.address)).toEqual(created);
    expect(await find(backupKey.address, account.address)).toBeNull();
    // Deployed, the account itself says whether the key still owns it.
    await arbitrum.write(contracts.factory, gatopagoAccountFactoryAbi, 'createAccount', [
      account.initialOwners,
      0n,
    ]);
    expect(await find(mera.address)).toEqual(created);
    await arbitrum.rpc('anvil_impersonateAccount', [account.address]);
    await arbitrum.rpc('anvil_setBalance', [account.address, toHex(10n ** 18n)]);
    for (const [functionName, owner] of [
      ['addOwners', backupKey.address],
      ['removeOwners', mera.address],
    ] as const) {
      const hash = await arbitrum.walletClient.writeContract({
        account: account.address,
        address: account.address,
        abi: gatopagoAccountAbi,
        functionName,
        args: [[keyOwner(owner)]],
      } as never);
      await arbitrum.publicClient.waitForTransactionReceipt({ hash });
    }
    expect(await find(mera.address)).toBeNull();
  }, 60_000);

  it('verifies approvals of a Mera account, whose owner is a key of 20 bytes', async () => {
    const mera = privateKeyToAccount(generatePrivateKey());
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: mera,
      contracts,
    });
    expect(account.initialOwners).toEqual([keyOwner(mera.address)]);
    const backup = softwarePasskey();
    const onBackup = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: backup,
      contracts,
      initialOwners: account.initialOwners,
    });
    const addBackup = encodeFunctionData({
      abi: gatopagoAccountAbi,
      functionName: 'addOwners',
      args: [[passkeyOwner(contracts.webAuthnVerifier, backup.publicKey)]],
    });
    const removeMera = encodeFunctionData({
      abi: gatopagoAccountAbi,
      functionName: 'removeOwners',
      args: [[keyOwner(mera.address)]],
    });
    const verify = (previous: Hex[], call: Hex, signature: Hex) =>
      verifyApproval(arbitrum.publicClient, {
        account: account.address,
        initialOwners: account.initialOwners,
        previous,
        call,
        signature,
      });

    // The Mera key adds a backup passkey; then the backup alone removes the Mera key.
    expect(await verify([], addBackup, await signApproval(account, 0n, addBackup))).toBe(
      keyOwner(mera.address).toLowerCase(),
    );
    expect(
      await verify([addBackup], removeMera, await signApproval(onBackup, 1n, removeMera)),
    ).toBe(passkeyOwner(contracts.webAuthnVerifier, backup.publicKey).toLowerCase());
    // Another key claiming to be the owner is refused.
    const stranger = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: privateKeyToAccount(generatePrivateKey()),
      contracts,
      initialOwners: account.initialOwners,
    });
    expect(await verify([], addBackup, await signApproval(stranger, 0n, addBackup))).toBeNull();
  }, 60_000);

  /** A funded account with a signed, sponsored transfer that has not been sent yet. */
  async function signedTransfer(amount: bigint) {
    const account = await toGatoPagoAccount({
      client: arbitrum.publicClient,
      owner: softwarePasskey(),
      contracts,
    });
    await mint(arbitrum, account.address);
    const bundlerClient = createBundlerClient({
      account,
      client: arbitrum.publicClient,
      paymaster: sponsorship as never,
      transport: http(arbitrum.bundlerUrl),
    });
    const prepared = await bundlerClient.prepareUserOperation({ calls: [transfer(amount)] });
    const operation = { ...prepared, signature: await account.signUserOperation(prepared) };
    const hash = getUserOperationHash({
      chainId: arbitrum.chain.id,
      entryPointAddress: entryPoint09Address,
      entryPointVersion: '0.9',
      userOperation: operation as UserOperation<'0.9'>,
    });
    return { bundlerClient, operation: operation as never, hash };
  }

  it('forgets records past their retention once their nonce is used, keeping recent ones', async () => {
    const old = await signedTransfer(1_000_000n);
    await old.bundlerClient.waitForUserOperationReceipt({
      hash: await old.bundlerClient.sendUserOperation(old.operation),
    });
    // Every record so far is made a week and a day old.
    const records = [...arbitrum.storage.keys()].filter((key) => key.startsWith('op:'));
    for (const key of records)
      arbitrum.storage.set(key, { ...(arbitrum.storage.get(key) as object), sentAt: 0 });
    const next = await signedTransfer(1_000_000n);
    const hash = await next.bundlerClient.sendUserOperation(next.operation);
    await next.bundlerClient.waitForUserOperationReceipt({ hash });
    // Each send walks up to 20 used nonces: old records below where it stopped are gone, the
    // others wait for the next sends, and the new one stays and still answers its receipt.
    const pruned = arbitrum.storage.get('pruned') as number;
    expect(pruned).toBeGreaterThan(0);
    for (const key of records) {
      const record = arbitrum.storage.get(key) as { nonce: number } | undefined;
      if (record) expect(record.nonce).toBeGreaterThanOrEqual(pruned);
    }
    expect(records.some((key) => !arbitrum.storage.has(key))).toBe(true);
    expect(arbitrum.storage.has(`op:${hash}`)).toBe(true);
    expect(await next.bundlerClient.getUserOperationReceipt({ hash })).toBeTruthy();
  }, 60_000);

  it('does not reuse the nonce of a recorded send that never reached the network', async () => {
    const first = await signedTransfer(1_000_000n);
    const second = await signedTransfer(1_000_000n);
    arbitrum.loseNextBroadcast('request');
    await expect(first.bundlerClient.sendUserOperation(first.operation)).rejects.toThrow();
    await second.bundlerClient.sendUserOperation(second.operation);

    for (const { bundlerClient, hash } of [second, first]) {
      const receipt = await bundlerClient.waitForUserOperationReceipt({
        hash,
        pollingInterval: 200,
        timeout: 20_000,
      });
      expect(receipt.success).toBe(true);
    }
  }, 60_000);

  it('reports a reverted bundle instead of waiting forever, so the operation can be resent', async () => {
    // A relayer transaction that reverts onchain, recorded as if it carried a UserOperation.
    const request = await arbitrum.walletClient.prepareTransactionRequest({
      to: entryPoint09Address,
      data: '0xdeadbeef',
      gas: 100_000n,
    });
    const raw = await arbitrum.walletClient.signTransaction(request);
    const transactionHash = await arbitrum.publicClient.sendRawTransaction({
      serializedTransaction: raw,
    });
    expect(
      (await arbitrum.publicClient.waitForTransactionReceipt({ hash: transactionHash })).status,
    ).toBe('reverted');
    const userOpHash = keccak256('0x01');
    arbitrum.storage.set(`op:${userOpHash}`, { transactionHash, raw, nonce: request.nonce });
    arbitrum.storage.set(`nonce:${request.nonce}`, userOpHash);

    await expect(
      arbitrum.bundler().handle('eth_getUserOperationReceipt', [userOpHash]),
    ).rejects.toThrow(/not included: the bundle transaction reverted/);
    expect(await arbitrum.bundler().handle('eth_getUserOperationReceipt', [userOpHash])).toBeNull();
  }, 60_000);

  it.each(['response', 'request'] as const)(
    'finds the operation after the bundler loses the broadcast %s',
    async (lost) => {
      const account = await toGatoPagoAccount({
        client: arbitrum.publicClient,
        owner: softwarePasskey(),
        contracts,
      });
      await mint(arbitrum, account.address);
      const bundlerClient = createBundlerClient({
        account,
        client: arbitrum.publicClient,
        paymaster: sponsorship as never,
        transport: http(arbitrum.bundlerUrl),
      });
      const prepared = await bundlerClient.prepareUserOperation({ calls: [transfer(1_000_000n)] });
      const operation = { ...prepared, signature: await account.signUserOperation(prepared) };
      const hash = getUserOperationHash({
        chainId: arbitrum.chain.id,
        entryPointAddress: entryPoint09Address,
        entryPointVersion: '0.9',
        userOperation: operation as UserOperation<'0.9'>,
      });

      arbitrum.loseNextBroadcast(lost);
      await expect(bundlerClient.sendUserOperation(operation as never)).rejects.toThrow();
      const receipt = await bundlerClient.waitForUserOperationReceipt({
        hash,
        pollingInterval: 200,
      });
      expect(receipt.success).toBe(true);
    },
    60_000,
  );
});
