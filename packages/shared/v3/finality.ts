import { toHex, type Hex, type PublicClient } from 'viem';
import { deploymentDocumentDigest, requireHash } from './deployment';
import { evmChainId, parseAtomicAmount, type NetworkId } from './primitives';

const mechanisms = [
  'ethereum_finalized',
  'arbitrum_l1_data_finalized',
  'op_stack_l1_data_finalized',
  'avalanche_accepted',
] as const;
type Mechanism = (typeof mechanisms)[number];
type Status = 'finalized' | 'pending' | 'stale' | 'disagreement' | 'reorg_detected' | 'unavailable';
interface Target {
  readonly network_id: NetworkId;
  readonly genesis_hash: Hex;
  readonly block_hash: Hex;
  readonly block_number: string;
  readonly block_timestamp: string;
}
interface Block {
  readonly block_hash: Hex;
  readonly block_number: string;
  readonly block_timestamp: string;
}
export interface FinalityPolicyPin {
  readonly document: string;
  readonly digest: Hex;
}
interface Policy {
  readonly schema_version: 1;
  readonly policy_id: string;
  readonly network_id: NetworkId;
  readonly genesis_hash: Hex;
  readonly mechanism: Mechanism;
  readonly valid_from: number;
  readonly valid_until: number;
  readonly max_latest_age_seconds: number;
  readonly max_finalized_age_seconds: number;
  readonly max_clock_skew_seconds: number;
  readonly evidence_ttl_seconds: number;
}
export interface FinalityAssessment {
  readonly schema_version: 1;
  readonly status: Status;
  readonly policy_sha256: Hex;
  readonly mechanism: Mechanism;
  readonly network_id: NetworkId;
  readonly genesis_hash: Hex;
  readonly target: Block;
  readonly checkpoint: Block | null;
  readonly assessed_at: number;
  readonly expires_at: number;
}
type Row = Record<string, unknown>;
const nowSeconds = () => Math.floor(Date.now() / 1000);
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid finality data');
  return value as Row;
}
function keys(value: Row, expected: readonly string[]) {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('Invalid finality fields');
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error('Invalid finality integer');
  return value;
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$(?![\s\S])/.test(value))
    throw new Error('Invalid RPC quantity');
  return BigInt(value);
}
function block(value: unknown): Block {
  const b = row(value);
  requireHash(b.hash);
  return Object.freeze({
    block_hash: b.hash,
    block_number: quantity(b.number).toString(),
    block_timestamp: quantity(b.timestamp).toString(),
  });
}
function validateBlock(value: unknown): asserts value is Block {
  const b = row(value);
  keys(b, ['block_hash', 'block_number', 'block_timestamp']);
  requireHash(b.block_hash);
  parseAtomicAmount(b.block_number);
  parseAtomicAmount(b.block_timestamp);
}
const height = (b: Block) => BigInt(b.block_number);
const time = (b: Block) => BigInt(b.block_timestamp);
const same = (a: Block, b: Block) =>
  a.block_hash === b.block_hash && height(a) === height(b) && time(a) === time(b);

export function loadPinnedFinalityPolicy(
  pin: FinalityPolicyPin,
  network: Pick<Target, 'network_id' | 'genesis_hash'>,
): Readonly<Policy> {
  requireHash(pin.digest);
  if (deploymentDocumentDigest(pin.document) !== pin.digest)
    throw new Error('Finality policy pin mismatch');
  const p = row(JSON.parse(pin.document));
  keys(p, [
    'schema_version',
    'policy_id',
    'network_id',
    'genesis_hash',
    'mechanism',
    'valid_from',
    'valid_until',
    'max_latest_age_seconds',
    'max_finalized_age_seconds',
    'max_clock_skew_seconds',
    'evidence_ttl_seconds',
  ]);
  if (
    p.schema_version !== 1 ||
    typeof p.policy_id !== 'string' ||
    !/^[a-z][a-z0-9_-]{1,63}$(?![\s\S])/.test(p.policy_id) ||
    p.network_id !== network.network_id ||
    p.genesis_hash !== network.genesis_hash ||
    !mechanisms.some((m) => m === p.mechanism)
  )
    throw new Error('Invalid finality policy');
  evmChainId(network.network_id);
  requireHash(network.genesis_hash);
  const validFrom = integer(p.valid_from, 1),
    mechanism = mechanisms.find((m) => m === p.mechanism);
  if (!mechanism) throw new Error('Invalid finality mechanism');
  return Object.freeze({
    schema_version: 1,
    policy_id: p.policy_id,
    network_id: network.network_id,
    genesis_hash: network.genesis_hash,
    mechanism,
    valid_from: validFrom,
    valid_until: integer(p.valid_until, validFrom + 1),
    max_latest_age_seconds: integer(p.max_latest_age_seconds, 1, 3600),
    max_finalized_age_seconds: integer(p.max_finalized_age_seconds, 1, 86400),
    max_clock_skew_seconds: integer(p.max_clock_skew_seconds, 0, 120),
    evidence_ttl_seconds: integer(p.evidence_ttl_seconds, 1, 60),
  });
}

export function assertFinalityAssessment(
  value: unknown,
  target: Target,
): asserts value is FinalityAssessment {
  const a = row(value);
  keys(a, [
    'schema_version',
    'status',
    'policy_sha256',
    'mechanism',
    'network_id',
    'genesis_hash',
    'target',
    'checkpoint',
    'assessed_at',
    'expires_at',
  ]);
  if (
    a.schema_version !== 1 ||
    a.network_id !== target.network_id ||
    a.genesis_hash !== target.genesis_hash ||
    !mechanisms.some((m) => m === a.mechanism) ||
    typeof a.status !== 'string' ||
    !['finalized', 'pending', 'stale', 'disagreement', 'reorg_detected', 'unavailable'].includes(
      a.status,
    )
  )
    throw new Error('Invalid finality assessment');
  requireHash(a.policy_sha256);
  requireHash(a.genesis_hash);
  validateBlock(a.target);
  if (!same(a.target, target)) throw new Error('Finality target mismatch');
  const assessed = integer(a.assessed_at, 1),
    expires = integer(a.expires_at, assessed, assessed + 60);
  if (a.status === 'finalized' || a.status === 'pending') {
    validateBlock(a.checkpoint);
    if (
      expires <= assessed ||
      (a.status === 'finalized') !== height(a.checkpoint) >= height(target) ||
      (height(a.checkpoint) === height(target) && !same(a.checkpoint, target)) ||
      (height(a.checkpoint) > height(target) && time(a.checkpoint) < time(target)) ||
      (height(a.checkpoint) < height(target) && time(a.checkpoint) > time(target))
    )
      throw new Error('Invalid finality checkpoint');
  } else if (a.checkpoint !== null || expires !== assessed)
    throw new Error('Failure cannot carry usable finality');
}

async function all<T>(operations: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  return results.map((r) => {
    if (r.status === 'rejected') throw r.reason;
    return r.value;
  });
}
async function readBlock(client: PublicClient, tag: Hex | 'latest' | 'finalized'): Promise<Block> {
  return block(
    await client.request(
      { method: 'eth_getBlockByNumber', params: [tag, false] },
      { dedupe: false, retryCount: 0 },
    ),
  );
}

export async function assessCheckpointFinality(
  clients: readonly PublicClient[],
  targetInput: Target,
  pin: FinalityPolicyPin,
  signal: AbortSignal,
): Promise<Readonly<FinalityAssessment>> {
  const target = Object.freeze({
    network_id: targetInput.network_id,
    genesis_hash: targetInput.genesis_hash,
    block_hash: targetInput.block_hash,
    block_number: parseAtomicAmount(targetInput.block_number),
    block_timestamp: parseAtomicAmount(targetInput.block_timestamp),
  });
  requireHash(target.block_hash);
  const digest = pin.digest,
    policy = loadPinnedFinalityPolicy(pin, target),
    started = integer(nowSeconds(), 1);
  if (clients.length !== 2) throw new Error('Exactly two finality clients required');
  const pair = [...clients];
  const finish = (
    status: Status,
    checkpoint: Block | null = null,
  ): Readonly<FinalityAssessment> => {
    const now = integer(nowSeconds(), 1),
      fresh = now >= started && now >= policy.valid_from && now < policy.valid_until;
    const resultStatus = signal.aborted ? 'unavailable' : fresh ? status : 'stale';
    const usable = resultStatus === 'finalized' || resultStatus === 'pending';
    const value = Object.freeze({
      schema_version: 1 as const,
      status: resultStatus,
      policy_sha256: digest,
      mechanism: policy.mechanism,
      network_id: target.network_id,
      genesis_hash: target.genesis_hash,
      target: Object.freeze({
        block_hash: target.block_hash,
        block_number: target.block_number,
        block_timestamp: target.block_timestamp,
      }),
      checkpoint: usable ? checkpoint : null,
      assessed_at: now,
      expires_at: usable ? Math.min(now + policy.evidence_ttl_seconds, policy.valid_until) : now,
    });
    assertFinalityAssessment(value, target);
    return value;
  };
  if (started < policy.valid_from || started >= policy.valid_until) return finish('stale');
  try {
    signal.throwIfAborted();
    const heads = await all(
      pair.map(async (client) => {
        const values = await all<unknown>([
          client.request({ method: 'eth_chainId' }, { dedupe: false, retryCount: 0 }),
          readBlock(client, '0x0'),
          readBlock(client, 'finalized'),
        ]);

        const genesis = values[1],
          finalized = values[2],
          latest = await readBlock(client, 'latest');
        validateBlock(genesis);
        validateBlock(latest);
        validateBlock(finalized);
        if (
          quantity(values[0]) !== evmChainId(target.network_id) ||
          height(genesis) !== 0n ||
          genesis.block_hash !== target.genesis_hash ||
          height(finalized) > height(latest) ||
          height(latest) < height(target) ||
          time(finalized) > time(latest)
        )
          throw new Error('Inconsistent finality heads');
        return { latest, finalized };
      }),
    );
    signal.throwIfAborted();
    const common =
      height(heads[0].finalized) <= height(heads[1].finalized)
        ? heads[0].finalized
        : heads[1].finalized;
    const checks = await all(
      pair.map(async (client, index) => {
        const [checkpoint, receiptBlock] = await all([
          readBlock(client, toHex(height(common))),
          readBlock(client, toHex(height(target))),
        ]);
        const [original, end] = await all([
          readBlock(client, toHex(height(heads[index].finalized))),
          readBlock(client, 'finalized'),
        ]);
        return { checkpoint, receiptBlock, original, end };
      }),
    );
    signal.throwIfAborted();
    for (const [index, check] of checks.entries()) {
      if (
        !same(check.receiptBlock, target) ||
        !same(check.original, heads[index].finalized) ||
        height(check.end) < height(heads[index].finalized) ||
        time(check.end) < time(heads[index].finalized) ||
        (height(check.end) === height(heads[index].finalized) &&
          !same(check.end, heads[index].finalized))
      )
        return finish('reorg_detected');
      if (height(check.checkpoint) !== height(common)) throw new Error('Wrong checkpoint height');
    }
    if (!same(checks[0].checkpoint, checks[1].checkpoint) || !same(checks[0].checkpoint, common))
      return finish('disagreement');
    const now = BigInt(nowSeconds()),
      skew = BigInt(policy.max_clock_skew_seconds);
    for (const [index, head] of heads.entries()) {
      if (
        time(head.latest) > now + skew ||
        now - time(head.latest) > BigInt(policy.max_latest_age_seconds) ||
        time(head.finalized) > now + skew ||
        now - time(head.finalized) > BigInt(policy.max_finalized_age_seconds) ||
        time(checks[index].end) > now + skew
      )
        return finish('stale');
    }
    return finish(height(common) >= height(target) ? 'finalized' : 'pending', common);
  } catch {
    return finish('unavailable');
  }
}
