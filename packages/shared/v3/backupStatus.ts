import { requireHash } from './deployment';
import { parseAtomicAmount, parseResourceId } from './primitives';

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
  || keys.some((key) => !Object.hasOwn(value, key))) throw new Error('Invalid backup status');
 return value as Record<string, unknown>;
}
function integer(value: unknown, min = 1): number {
 if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > 8_640_000_000_000) throw new Error('Invalid status time');
 return value;
}
function hash(value: unknown) { requireHash(value); return value; }
function choice<const T extends string>(value: unknown, allowed: readonly T[]): T {
 if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error('Invalid status state');
 return value as T;
}

/** Historical, owner-scoped progress. Never a spend permission or fresh proof that
 * the user possesses a key. Explicit expected IDs prevent cross-request mixups. */
export function parseBackupStatus(value: unknown, expected: { backupId: string; operationId: string; kind: 'prepare' | 'commit'; proposalHash: string }) {
 const r = object(value, ['schema_version','backup_id','operation_id','kind','proposal_hash','consent_state',
  'delivery_state','transaction_hash','job_state','reason','observation','policy_confirmation','account_readiness','snapshot_at']);
 const backupId = parseResourceId('operation', r.backup_id), operationId = parseResourceId('operation', r.operation_id);
 requireHash(r.proposal_hash);
 if (r.schema_version !== 1 || r.account_readiness !== 'not_assessed' || backupId !== expected.backupId
  || operationId !== expected.operationId || r.kind !== expected.kind || r.proposal_hash !== expected.proposalHash
  || (r.kind === 'prepare' && backupId !== operationId) || (r.kind === 'commit' && backupId === operationId)) throw new Error('Mismatched backup status');
 const consent = choice(r.consent_state, ['prepared','authorized','expired']);
 const delivery = choice(r.delivery_state, ['not_requested','pending','sending','uncertain','accepted','expired']);
 const job = choice(r.job_state, ['not_requested','ready','queued','running','observed','expired','review']);
 const reason = r.reason === null ? null : choice(r.reason, ['proposal_finalized','commit_finalized','consent_expired',
  'revoked','execution_reverted','observation_timeout','reorg_detected','delivery_exhausted','processing_error']);
 const snapshot = integer(r.snapshot_at), transactionHash = r.transaction_hash === null ? null : hash(r.transaction_hash);
 const sent = ['sending','uncertain','accepted'].includes(delivery);
 if ((consent === 'authorized') !== (delivery !== 'not_requested') || (delivery === 'not_requested') !== (job === 'not_requested')
  || sent !== (transactionHash !== null) || (['observed','expired','review'].includes(job)) !== (reason !== null)
  || (job === 'observed' && reason !== (r.kind === 'commit' ? 'commit_finalized' : 'proposal_finalized'))
  || (job === 'expired' && reason !== 'consent_expired')
  || (job === 'review' && ['proposal_finalized','commit_finalized','consent_expired'].includes(reason!))) throw new Error('Conflicting backup progress');
 const observation = r.observation === null ? null : (() => {
  const o = object(r.observation, ['epoch','observed_at','status','finality','outcome','block_number','block_hash','evidence_expires_at']);
  const epoch = integer(o.epoch), observed = integer(o.observed_at);
  const status = choice(o.status, ['observed','not_observed','unavailable','disagreement']);
  const finality = choice(o.finality, ['not_assessed','finalized','pending','stale','disagreement','reorg_detected','unavailable']);
  const outcome = o.outcome === null ? null : choice(o.outcome, ['proposal_prepared','backup_committed','execution_reverted']);
  const number = o.block_number === null ? null : parseAtomicAmount(o.block_number);
  const blockHash = o.block_hash === null ? null : hash(o.block_hash);
  const expires = o.evidence_expires_at === null ? null : integer(o.evidence_expires_at);
  if (!sent || observed > snapshot || (status === 'observed' ? outcome === null || number === null || blockHash === null || expires === null || finality === 'not_assessed'
   : outcome !== null || number !== null || blockHash !== null || expires !== null || finality !== 'not_assessed')
   || (outcome && outcome !== 'execution_reverted' && outcome !== (r.kind === 'commit' ? 'backup_committed' : 'proposal_prepared'))) throw new Error('Invalid backup observation');
  return Object.freeze({ epoch, observed_at: observed, status, finality, outcome, block_number: number, block_hash: blockHash, evidence_expires_at: expires });
 })();
 const confirmation = r.policy_confirmation === null ? null : (() => {
  const p = object(r.policy_confirmation, ['manifest_hash','recorded_at','evidence_expires_at','source_epoch']);
  const manifest = hash(p.manifest_hash), recorded = integer(p.recorded_at), expires = integer(p.evidence_expires_at), epoch = integer(p.source_epoch);
  if (r.kind !== 'commit' || !sent || recorded > snapshot || expires <= recorded || !observation || epoch > observation.epoch) throw new Error('Invalid policy history');
  return Object.freeze({ manifest_hash: manifest, recorded_at: recorded, evidence_expires_at: expires, source_epoch: epoch });
 })();
 if ((job === 'observed' && (!observation || (r.kind === 'commit' && !confirmation)))
  || (job === 'expired' && delivery !== 'expired')) throw new Error('Unsupported completion claim');
 return Object.freeze({ schema_version: 1 as const, backup_id: backupId, operation_id: operationId, kind: expected.kind,
  proposal_hash: r.proposal_hash, consent_state: consent, delivery_state: delivery, transaction_hash: transactionHash, job_state: job, reason,
  observation, policy_confirmation: confirmation, account_readiness: 'not_assessed' as const, snapshot_at: snapshot });
}
