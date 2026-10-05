import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
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
  getContractAddress,
  http,
  keccak256,
  toHex,
  zeroHash,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
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
  passkeyOwner,
  signApproval,
  sponsorshipPaymasterData,
  verifyApproval,
  sponsorshipTypedData,
  toGatoPagoAccount,
  type GatoPagoAccount,
  type WalletContracts,
} from '../packages/shared/wallet';
import { bundlerJsonRpc, createBundler, gatopagoGasConfig } from '../packages/shared/bundler';

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
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
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
          put: async (key, value) => void storage.set(key, value),
          delete: async (key) => storage.delete(key),
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

/** Software passkey producing the same bytes as `navigator.credentials.get`. */
function softwarePasskey(): WebAuthnAccount {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const coordinate = (value: string) => Buffer.from(value, 'base64url').toString('hex');
  return {
    id: 'software-passkey',
    publicKey: `0x${coordinate(jwk.x!)}${coordinate(jwk.y!)}`,
    type: 'webAuthn',
    async sign({ hash }) {
      const authenticatorData = Buffer.concat([
        createHash('sha256').update('gatopago.com').digest(),
        Buffer.from([0x05, 0, 0, 0, 0]),
      ]);
      const challenge = Buffer.from(hash.slice(2), 'hex').toString('base64url');
      const clientDataJSON = `{"type":"webauthn.get","challenge":"${challenge}","origin":"https://gatopago.com","crossOrigin":false}`;
      const signed = Buffer.concat([
        authenticatorData,
        createHash('sha256').update(clientDataJSON).digest(),
      ]);
      return {
        signature: toHex(sign('sha256', signed, { key: privateKey, dsaEncoding: 'ieee-p1363' })),
        raw: {} as never,
        webauthn: {
          authenticatorData: toHex(authenticatorData),
          clientDataJSON,
          challengeIndex: 23,
          typeIndex: 1,
          userVerificationRequired: true,
        },
      };
    },
    async signMessage() {
      throw new Error('unused');
    },
    async signTypedData() {
      throw new Error('unused');
    },
  };
}

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
    expect(await verify([], addLaptop, first)).toBe(true);
    expect(await verify([], removePhone, first)).toBe(false); // altered call
    expect(await verify([], addLaptop, await signApproval(onLaptop, 0n, addLaptop))).toBe(false); // not an owner yet

    const second = await signApproval(onLaptop, 1n, removePhone);
    expect(await verify([addLaptop], removePhone, second)).toBe(true); // the laptop is an owner after approval 0
    expect(await verify([], removePhone, second)).toBe(false); // out of order
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
