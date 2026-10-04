import { requireHash } from './deployment';
import { parseResourceId } from './primitives';

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('Invalid creation lifecycle');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > 8_640_000_000_000
  )
    throw new Error('Invalid lifecycle time');
  return value;
}
function choice<const T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new Error('Invalid lifecycle state');
  return value as T;
}

export function parseCreationLifecycle(
  value: unknown,
  receipt: { state: 'prepared' | 'authorized'; delivery_state: string },
  observedAt: number,
) {
  integer(observedAt);
  const r = object(value, ['job_state', 'reason', 'observation', 'bootstrap', 'account_readiness']);
  const jobState = choice(r.job_state, [
    'not_requested',
    'ready',
    'queued',
    'running',
    'complete',
    'review',
  ]);
  const reason =
    r.reason === null
      ? null
      : choice(r.reason, [
          'projected',
          'expired',
          'revoked',
          'execution_reverted',
          'observation_timeout',
          'processing_error',
        ]);
  if (
    r.account_readiness !== 'not_assessed' ||
    (receipt.state === 'prepared') !== (jobState === 'not_requested') ||
    ['complete', 'review'].includes(jobState) !== (reason !== null) ||
    (jobState === 'complete' && reason !== 'projected' && reason !== 'expired') ||
    (jobState === 'review' && (reason === 'projected' || reason === 'expired'))
  )
    throw new Error('Invalid lifecycle job');
  const observation =
    r.observation === null
      ? null
      : (() => {
          const o = object(r.observation, [
            'epoch',
            'observed_at',
            'status',
            'finality',
            'valid_until',
            'transaction_hash',
            'outcome',
          ]);
          const epoch = integer(o.epoch, 1),
            observed = integer(o.observed_at, 1);
          const status = choice(o.status, [
            'observed',
            'not_observed',
            'unavailable',
            'disagreement',
          ]);
          const finality = choice(o.finality, [
            'not_assessed',
            'finalized',
            'pending',
            'stale',
            'disagreement',
            'reorg_detected',
            'unavailable',
          ]);
          const until = o.valid_until === null ? null : integer(o.valid_until, 1);
          const outcome =
            o.outcome === null
              ? null
              : choice(o.outcome, ['creation_succeeded', 'execution_reverted']);
          if (o.transaction_hash !== null) requireHash(o.transaction_hash);
          if (
            observed > observedAt ||
            (status === 'observed'
              ? outcome === null || o.transaction_hash === null
              : outcome !== null || o.transaction_hash !== null || finality !== 'not_assessed') ||
            (finality === 'not_assessed') !== (until === null)
          )
            throw new Error('Invalid lifecycle observation');
          return Object.freeze({
            epoch,
            observed_at: observed,
            status,
            finality,
            valid_until: until,
            transaction_hash: o.transaction_hash,
            outcome,
          });
        })();
  const bootstrap =
    r.bootstrap === null
      ? null
      : (() => {
          const b = object(r.bootstrap, [
            'recorded_at',
            'evidence_expires_at',
            'wallet_id',
            'wallet_account_id',
          ]);
          const recorded = integer(b.recorded_at, 1),
            expires = integer(b.evidence_expires_at, 1);
          if (recorded > observedAt || expires <= recorded)
            throw new Error('Invalid bootstrap time');
          return Object.freeze({
            recorded_at: recorded,
            evidence_expires_at: expires,
            wallet_id: parseResourceId('wallet', b.wallet_id),
            wallet_account_id: parseResourceId('walletAccount', b.wallet_account_id),
          });
        })();
  if (
    (receipt.state === 'prepared' && (observation || bootstrap)) ||
    ((observation || bootstrap) &&
      !['sending', 'uncertain', 'accepted'].includes(receipt.delivery_state)) ||
    (reason === 'projected' && !bootstrap) ||
    (reason === 'expired' && receipt.delivery_state !== 'expired') ||
    (bootstrap && (jobState === 'review' || reason === 'expired'))
  )
    throw new Error('Conflicting lifecycle evidence');
  return Object.freeze({
    job_state: jobState,
    reason,
    observation,
    bootstrap,
    account_readiness: 'not_assessed' as const,
  });
}
