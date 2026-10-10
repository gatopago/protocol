import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  hexToBytes,
  http,
  isAddressEqual,
  keccak256,
  numberToHex,
  parseAbi,
  parseEventLogs,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type RpcTransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  entryPoint09Abi,
  entryPoint09Address,
  formatUserOperation,
  getUserOperationHash,
  toPackedUserOperation,
  type RpcUserOperation,
  type UserOperation,
} from 'viem/account-abstraction';

/**
 * Validation ceilings. Unused validation gas is not charged; execution gas is simulated per operation
 * (the EntryPoint charges 10% of unused call gas) and `preVerificationGas` is computed from the
 * operation's bytes.
 */
export interface BundlerGasConfig {
  /** Passkey validation of a deployed account with the P256 precompile. */
  readonly verificationGasLimit: bigint;
  /** Added to validation on networks without the P256 precompile (verification in Solidity). */
  readonly p256FallbackGasLimit: bigint;
  /** Added to validation when the operation deploys the account. */
  readonly deploymentGasLimit: bigint;
  readonly paymasterVerificationGasLimit: bigint;
  readonly paymasterPostOpGasLimit: bigint;
}

/**
 * GatoPago account and paymaster. Measured: passkey validation up to ~33k with the P256 precompile
 * and ~382k without it, account deployment ~288k.
 */
export const gatopagoGasConfig: BundlerGasConfig = {
  verificationGasLimit: 100_000n,
  p256FallbackGasLimit: 400_000n,
  deploymentGasLimit: 400_000n,
  paymasterVerificationGasLimit: 60_000n,
  paymasterPostOpGasLimit: 0n,
};

const factoryAbi = parseAbi(['function implementation() view returns (address)']);
/** RIP-7212 / EIP-7951 P256 verification precompile and a valid (hash, r, s, x, y) input for it. */
const P256_PRECOMPILE = '0x0000000000000000000000000000000000000100';
const P256_PROBE =
  '0x4ec624ac28a234874f1efa33e37da5d1165166dc6caac97a20f4c336eea2f59b64fe938870d8af6d9a6e437d88686113e790be1dea878e9e66a0508cd190c825b2cdaa4ea81cabfc99081bc4bb20eff4af8af9d7d915ca985d873bed41b9d750f94a4cf86943ffbae614ff1435d173585b0bbbda423ad375085b927958b1a6f80b79120a292af23b93d71b9a1eae764d9afe4ec9064600fc5a0de7c503daf86f';
/** Arbitrum's NodeInterface (RPC-only precompile, read with eth_call, hence `view`). */
const nodeInterfaceAbi = parseAbi([
  'function gasEstimateL1Component(address to, bool contractCreation, bytes data) view returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)',
]);
const ARBITRUM_NODE_INTERFACE = '0x00000000000000000000000000000000000000C8';
/** EntryPoint work per operation outside its own gas metering (standard bundler value). */
const PER_OPERATION_OVERHEAD = 18_300n;
/** Real passkey signatures can carry a longer clientDataJSON than the estimation stub. */
const SIGNATURE_VARIANCE_BYTES = 256n;

const calldataGas = (data: Hex) =>
  hexToBytes(data).reduce((gas, byte) => gas + (byte === 0 ? 4n : 16n), 0n);
const withMargin = (gas: bigint) => (gas * 120n) / 100n + 10_000n;

/** The signed `handleOps` transaction carrying one UserOperation. */
interface BundledTransaction {
  readonly transactionHash: Hash;
  readonly raw: Hex;
  readonly nonce: number;
  /** When it was signed (seconds): records are kept `RETENTION_SECONDS`. */
  readonly sentAt: number;
}

/**
 * How long a sent operation's record is kept: its receipt is asked for while the app waits on it
 * (minutes), so a week is ample. Older records whose nonce the network already used are removed,
 * a few at each send, so storage does not grow forever.
 */
const RETENTION_SECONDS = 7 * 86_400;
const PRUNED_PER_SEND = 20;

/**
 * Durable key-value storage, as the Durable Object storage API (Wallet Core passes `ctx.storage`).
 * Each signed transaction is recorded with its relayer nonce before it is broadcast, so an
 * interrupted send is rebroadcast instead of its nonce being reused. Writing or deleting several
 * keys in one call must be atomic, as it is there.
 */
export interface BundlerStore {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
}

export class BundlerRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Minimal ERC-4337 bundler for operations sponsored by GatoPago's paymaster (EntryPoint v0.9).
 * It speaks the standard bundler JSON-RPC methods, so viem's `createBundlerClient` (or a full
 * bundler such as Alto/Skandha later) is interchangeable. Each operation is sent alone in a
 * `handleOps` transaction from the relayer, which the EntryPoint refunds from the paymaster deposit.
 * Callers must serialize `handle` per relayer (one Durable Object per network).
 */
export function createBundler(parameters: {
  chain: Chain;
  rpcUrl: string;
  relayerKey: Hex;
  paymaster: Address;
  gas: BundlerGasConfig;
  /** Network whose transactions also pay for L1 data, priced into `preVerificationGas`. */
  l1Fees?: 'arbitrum';
  store: BundlerStore;
}) {
  const { chain, paymaster, gas, store, l1Fees } = parameters;
  const transport = http(parameters.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const relayer = privateKeyToAccount(parameters.relayerKey);
  const walletClient = createWalletClient({ chain, transport, account: relayer });
  let p256Precompile: Promise<boolean> | undefined;
  const hasP256Precompile = () =>
    (p256Precompile ??= publicClient
      .call({ to: P256_PRECOMPILE, data: P256_PROBE })
      .then(({ data }) => data !== undefined && BigInt(data) === 1n));

  function requireEntryPoint(entryPoint: unknown) {
    if (
      typeof entryPoint !== 'string' ||
      !isAddressEqual(entryPoint as Address, entryPoint09Address)
    )
      throw new BundlerRpcError(-32602, 'Unsupported EntryPoint');
  }

  function sponsoredOperation(rpc: unknown) {
    const operation = formatUserOperation(rpc as RpcUserOperation) as UserOperation<'0.9'>;
    if (!operation.paymaster || !isAddressEqual(operation.paymaster, paymaster))
      throw new BundlerRpcError(-32602, 'Only GatoPago-sponsored operations are accepted');
    return operation;
  }

  async function estimate(operation: UserOperation<'0.9'>) {
    const deployed = (await publicClient.getCode({ address: operation.sender })) !== undefined;
    const limits = {
      verificationGasLimit:
        gas.verificationGasLimit +
        ((await hasP256Precompile()) ? 0n : gas.p256FallbackGasLimit) +
        (operation.factory && !deployed ? gas.deploymentGasLimit : 0n),
      callGasLimit: await callGasLimit(operation, deployed),
      paymasterVerificationGasLimit: gas.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: gas.paymasterPostOpGasLimit,
    };
    return { ...limits, preVerificationGas: await preVerificationGas({ ...operation, ...limits }) };
  }

  /**
   * Simulates the whole call as the EntryPoint executes it, so a batch keeps its state between calls
   * (`approve` then `supply`). An account that does not exist yet is simulated with its factory's
   * implementation code at its address (state override).
   */
  async function callGasLimit(operation: UserOperation<'0.9'>, deployed: boolean) {
    if (operation.callData === '0x') return 0n;
    const stateOverride =
      deployed || !operation.factory
        ? undefined
        : [
            {
              address: operation.sender,
              code: await publicClient.getCode({
                address: await publicClient.readContract({
                  address: operation.factory,
                  abi: factoryAbi,
                  functionName: 'implementation',
                }),
              }),
            },
          ];
    try {
      const used = await publicClient.estimateGas({
        account: entryPoint09Address,
        to: operation.sender,
        data: operation.callData,
        stateOverride,
      });
      return withMargin(used - 21_000n - calldataGas(operation.callData));
    } catch {
      throw new BundlerRpcError(-32500, 'UserOperation execution reverts');
    }
  }

  /** Gas the EntryPoint does not meter: transaction intrinsic and calldata, plus L1 data on Arbitrum. */
  async function preVerificationGas(operation: UserOperation<'0.9'>) {
    const bundle = encodeFunctionData({
      abi: entryPoint09Abi,
      functionName: 'handleOps',
      args: [[toPackedUserOperation(operation)], relayer.address],
    });
    let total =
      21_000n + calldataGas(bundle) + SIGNATURE_VARIANCE_BYTES * 16n + PER_OPERATION_OVERHEAD;
    if (l1Fees === 'arbitrum') {
      const [l1] = await publicClient.readContract({
        address: ARBITRUM_NODE_INTERFACE,
        abi: nodeInterfaceAbi,
        functionName: 'gasEstimateL1Component',
        args: [entryPoint09Address, false, bundle],
      });
      total += (l1 * 125n) / 100n; // L1 prices move between estimation and inclusion.
    }
    return total;
  }

  async function send(operation: UserOperation<'0.9'>) {
    const userOpHash = getUserOperationHash({
      chainId: chain.id,
      entryPointAddress: entryPoint09Address,
      entryPointVersion: '0.9',
      userOperation: operation,
    });
    // A retry of a recorded operation returns it instead of building another bundle, unless it is
    // known not to have been included (then `receipt` forgets it and it is sent again).
    if (await store.get(`op:${userOpHash}`)) {
      try {
        await receipt(userOpHash);
        return userOpHash;
      } catch (error) {
        if (!(error instanceof BundlerRpcError)) throw error;
      }
    }
    const request = {
      address: entryPoint09Address,
      abi: entryPoint09Abi,
      functionName: 'handleOps',
      args: [[toPackedUserOperation(operation)], relayer.address],
      account: relayer,
    } as const;
    try {
      await publicClient.simulateContract(request);
    } catch (error) {
      const reverted =
        error instanceof BaseError
          ? error.walk((e) => e instanceof ContractFunctionRevertedError)
          : null;
      const reason =
        reverted instanceof ContractFunctionRevertedError ? reverted.data?.args?.at(-1) : undefined;
      throw new BundlerRpcError(
        -32500,
        typeof reason === 'string' ? reason : 'UserOperation simulation failed',
      );
    }
    const { nonce, used } = await nextNonce();
    await prune(used);
    const prepared = await walletClient.prepareTransactionRequest({
      to: entryPoint09Address,
      data: encodeFunctionData(request),
      nonce,
    });
    const raw = await walletClient.signTransaction(prepared);
    // The transaction and its nonce's reservation are recorded together, or not at all.
    await store.put({
      [`op:${userOpHash}`]: {
        transactionHash: keccak256(raw),
        raw,
        nonce,
        sentAt: Math.floor(Date.now() / 1000),
      } satisfies BundledTransaction,
      [`nonce:${nonce}`]: userOpHash,
      nextNonce: nonce + 1,
    });
    await publicClient.sendRawTransaction({ serializedTransaction: raw });
    return userOpHash;
  }

  /** Never reuses a recorded nonce: first rebroadcasts recorded transactions the network has not seen. */
  async function nextNonce() {
    const network = await publicClient.getTransactionCount({
      address: relayer.address,
      blockTag: 'pending',
    });
    const reserved = (await store.get<number>('nextNonce')) ?? 0;
    for (let nonce = network; nonce < reserved; nonce++) {
      const userOpHash = await store.get<Hash>(`nonce:${nonce}`);
      const bundled = userOpHash && (await store.get<BundledTransaction>(`op:${userOpHash}`));
      if (bundled)
        await publicClient
          .sendRawTransaction({ serializedTransaction: bundled.raw })
          .catch(() => undefined);
    }
    return { nonce: Math.max(network, reserved), used: network };
  }

  /**
   * Removes the oldest records past `RETENTION_SECONDS` whose nonce the network already used
   * (below `used`), from where the last pruning stopped; a pending one is never touched.
   */
  async function prune(used: number) {
    let next = (await store.get<number>('pruned')) ?? 0;
    const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
    for (let i = 0; i < PRUNED_PER_SEND && next < used; i++, next++) {
      const userOpHash = await store.get<Hash>(`nonce:${next}`);
      const bundled = userOpHash && (await store.get<BundledTransaction>(`op:${userOpHash}`));
      if (bundled && bundled.sentAt > cutoff) break;
      await store.delete(userOpHash ? [`op:${userOpHash}`, `nonce:${next}`] : [`nonce:${next}`]);
    }
    await store.put({ pruned: next });
  }

  /** The bundle failed without including the operation: forget it so the client can resubmit it. */
  async function notIncluded(
    userOpHash: Hash,
    bundled: BundledTransaction,
    reason: string,
  ): Promise<never> {
    await store.delete([`op:${userOpHash}`, `nonce:${bundled.nonce}`]);
    throw new BundlerRpcError(-32500, `UserOperation was not included: ${reason}`);
  }

  async function receipt(userOpHash: Hash) {
    const bundled = await store.get<BundledTransaction>(`op:${userOpHash}`);
    if (!bundled) return null;
    const rpcReceipt = (await publicClient.request({
      method: 'eth_getTransactionReceipt',
      params: [bundled.transactionHash],
    })) as RpcTransactionReceipt | null;
    if (!rpcReceipt) {
      const confirmed = await publicClient.getTransactionCount({
        address: relayer.address,
        blockTag: 'latest',
      });
      if (confirmed > bundled.nonce)
        return notIncluded(
          userOpHash,
          bundled,
          'its relayer nonce was used by another transaction',
        );
      // Recorded but unknown to the node (an interrupted send): rebroadcast the same bytes.
      const known = await publicClient.request({
        method: 'eth_getTransactionByHash',
        params: [bundled.transactionHash],
      });
      if (!known)
        await publicClient
          .sendRawTransaction({ serializedTransaction: bundled.raw })
          .catch(() => undefined);
      return null;
    }
    if (rpcReceipt.status !== '0x1')
      return notIncluded(userOpHash, bundled, 'the bundle transaction reverted');
    const event = parseEventLogs({
      abi: entryPoint09Abi,
      eventName: 'UserOperationEvent',
      logs: rpcReceipt.logs.map((log) => ({
        ...log,
        blockNumber: BigInt(log.blockNumber!),
        logIndex: Number(log.logIndex),
        transactionIndex: Number(log.transactionIndex),
      })) as never,
    }).find((log) => log.args.userOpHash === userOpHash);
    if (!event) return notIncluded(userOpHash, bundled, 'no UserOperationEvent in the bundle');
    return {
      userOpHash,
      entryPoint: entryPoint09Address,
      sender: event.args.sender,
      nonce: numberToHex(event.args.nonce),
      paymaster: event.args.paymaster,
      actualGasCost: numberToHex(event.args.actualGasCost),
      actualGasUsed: numberToHex(event.args.actualGasUsed),
      success: event.args.success,
      reason: '',
      logs: rpcReceipt.logs.filter((log) => !isAddressEqual(log.address, entryPoint09Address)),
      receipt: rpcReceipt,
    };
  }

  return {
    relayer: relayer.address,
    async handle(method: string, params: readonly unknown[] = []): Promise<unknown> {
      switch (method) {
        case 'eth_chainId':
          return numberToHex(chain.id);
        case 'eth_supportedEntryPoints':
          return [entryPoint09Address];
        case 'eth_estimateUserOperationGas': {
          requireEntryPoint(params[1]);
          const limits = await estimate(sponsoredOperation(params[0]));
          return Object.fromEntries(
            Object.entries(limits).map(([name, value]) => [name, numberToHex(value)]),
          );
        }
        case 'eth_sendUserOperation':
          requireEntryPoint(params[1]);
          return send(sponsoredOperation(params[0]));
        case 'eth_getUserOperationReceipt':
          return receipt(params[0] as Hash);
        default:
          throw new BundlerRpcError(-32601, `Method not supported: ${method}`);
      }
    },
  };
}

/** JSON-RPC 2.0 envelope around `createBundler(...).handle`. */
export async function bundlerJsonRpc(
  bundler: ReturnType<typeof createBundler>,
  body: unknown,
): Promise<{
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}> {
  const request = (body ?? {}) as { id?: unknown; method?: unknown; params?: unknown };
  const id = request.id ?? null;
  try {
    if (typeof request.method !== 'string') throw new BundlerRpcError(-32600, 'Invalid request');
    const params = Array.isArray(request.params) ? request.params : [];
    return { jsonrpc: '2.0', id, result: await bundler.handle(request.method, params) };
  } catch (error) {
    if (error instanceof BundlerRpcError)
      return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message } };
    return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } };
  }
}
