import { zeroHash } from 'viem';
import { hashSecurityManifest } from './authorizations';
import {
  prepareBackupEnrollment,
  prepareBackupCommit,
  type BackupEnrollmentInput,
} from './backupEnrollment';
import type { CreationConsent } from './creationOperationWire';
import { deploymentDocumentDigest, requireHash } from './deployment';
import { prepareInitialization, type InitializationInput } from './initialization';
import { parseInitializationPreparation } from './initializationWire';
import { parseAtomicAmount, parseResourceId } from './primitives';
import { hashSecurityPolicy, type SecurityPolicy } from './securityPolicy';

export interface BackupSelection {
  readonly consent: CreationConsent;
  readonly backupId: string;
  readonly walletId: string;
  readonly walletAccountId: string;
  readonly nextPolicy: SecurityPolicy;
  readonly proposalValidUntil: number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid backup object');
  return value as Record<string, unknown>;
}
function fields(value: unknown, keys: readonly string[]) {
  const r = object(value);
  if (Object.keys(r).length !== keys.length || keys.some((key) => !Object.hasOwn(r, key)))
    throw new Error('Invalid backup fields');
  return r;
}

function equal(value: unknown, expected: unknown): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(value) || value.length !== expected.length)
      throw new Error('Invalid backup array');
    expected.forEach((item, index) => equal(value[index], item));
  } else if (expected && typeof expected === 'object') {
    const entries = Object.entries(expected),
      r = fields(
        value,
        entries.map(([key]) => key),
      );
    entries.forEach(([key, item]) => equal(r[key], item));
  } else if (value !== expected) throw new Error('Backup terms mismatch');
}
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= 2 ** 48)
    throw new Error('Invalid backup time');
  return value;
}
function policy(value: SecurityPolicy): SecurityPolicy {
  if (!Array.isArray(value.signers) || value.signers.length > 16)
    throw new Error('Invalid backup policy');
  const p: SecurityPolicy = {
    mode: value.mode,
    signers: value.signers.map((s) =>
      Object.freeze({
        kind: s.kind,
        verifier: s.verifier,
        verifierCodeHash: s.verifierCodeHash,
        key: s.key,
        roles: s.roles,
      }),
    ),
    spendThreshold: value.spendThreshold,
    adminThreshold: value.adminThreshold,
    upgradeDelaySeconds: value.upgradeDelaySeconds,
  };
  equal(value, p);
  hashSecurityPolicy(p);
  if (p.mode !== 'active') throw new Error('Invalid backup policy');
  Object.freeze(p.signers);
  return Object.freeze(p);
}

export function parseBackupSelection(value: BackupSelection) {
  const expected = Object.freeze({
    ...value.consent.expected,
    scope: Object.freeze({ ...value.consent.expected.scope }),
  });
  const preparation = parseInitializationPreparation(value.consent.preparation, expected);
  if (preparation.state !== 'authorized') throw new Error('Backup needs authorized initialization');
  return Object.freeze({
    backupId: parseResourceId('operation', value.backupId),
    walletId: parseResourceId('wallet', value.walletId),
    walletAccountId: parseResourceId('walletAccount', value.walletAccountId),
    consent: Object.freeze({ preparation, expected }),
    nextPolicy: policy(value.nextPolicy),
    proposalValidUntil: time(value.proposalValidUntil),
  });
}
function initialization(selected: ReturnType<typeof parseBackupSelection>): InitializationInput {
  const { expected: e, preparation: p } = selected.consent;
  return Object.freeze({
    document: e.document,
    expectedDigest: e.profileDigest,
    scope: e.scope,
    publicKey: p.public_key,
    userSaltCommitment: e.userSaltCommitment,
    validAfter: p.valid_after,
    validUntil: p.valid_until,
  });
}

function observation(
  value: unknown,
  input: InitializationInput,
  pending: boolean,
): BackupEnrollmentInput['observation'] {
  const r = object(value),
    s = object(r.security),
    c = object(r.checkpoint),
    n = object(s.nonces);
  requireHash(c.block_hash);
  if (typeof s.upgrades_frozen !== 'boolean') throw new Error('Invalid backup freeze');
  const initial = prepareInitialization(input),
    deployment = initial.profile.deployment;
  let proposal: BackupEnrollmentInput['observation']['security']['pending'] = null;
  if (pending) {
    const p = object(s.pending);
    requireHash(p.hash);
    requireHash(p.previous_manifest_hash);
    requireHash(p.chain_scope_hash);
    proposal = {
      kind: 1,
      hash: p.hash,
      security_version: '1',
      previous_manifest_hash: p.previous_manifest_hash,
      chain_scope_hash: p.chain_scope_hash,
      ready_at: time(p.ready_at),
      valid_until: time(p.valid_until),
    };
  }
  const result: BackupEnrollmentInput['observation'] = {
    status: 'recognized',
    account: initial.account,
    account_id: initial.message.accountId,
    network_id: deployment.network_id,
    manifest_id: deployment.manifest_id,
    manifest_sha256: deploymentDocumentDigest(JSON.stringify(deployment)),
    checkpoint: { block_hash: c.block_hash, block_number: parseAtomicAmount(c.block_number) },
    spend_readiness: 'not_assessed',
    implementation: deployment.components.implementation.address,
    security_version: '1',
    storage_layout_hash: deployment.storage_layout_hash,
    security: {
      phase: 'active_policy',
      policy: initial.policy,
      policy_hash: initial.message.initialSecurityCommitment,
      manifest_hash: hashSecurityManifest({
        accountId: initial.message.accountId,
        generation: 3,
        securityVersion: 1n,
        previousManifestHash: zeroHash,
        policyHash: initial.message.initialSecurityCommitment,
        chainScopeHash: initial.message.chainScopeHash,
      }),
      chain_scope_hash: initial.message.chainScopeHash,
      upgrades_frozen: s.upgrades_frozen,
      creation_valid_after: 0,
      creation_valid_until: 0,
      nonces: { spend: parseAtomicAmount(n.spend), admin: parseAtomicAmount(n.admin) },
      pending: proposal,
    },
  };
  equal(value, result);
  return result;
}
function backupInput(value: unknown, selected: ReturnType<typeof parseBackupSelection>) {
  const r = object(value),
    initial = initialization(selected);
  const result: BackupEnrollmentInput = {
    initialization: initial,
    observation: observation(r.observation, initial, false),
    nextPolicy: selected.nextPolicy,
    validAfter: time(r.validAfter),
    validUntil: time(r.validUntil),
    proposalValidUntil: selected.proposalValidUntil,
  };
  equal(value, result);
  return result;
}
const assessment = Object.freeze({
  backup_assessment: 'not_assessed' as const,
  receive_enabled: false as const,
  spend_enabled: false as const,
});
function receipt<T extends object>(value: unknown, expected: T) {
  const r = fields(value, [...Object.keys(expected), 'state']);
  equal(Object.fromEntries(Object.keys(expected).map((key) => [key, r[key]])), expected);
  if (r.state !== 'prepared' && r.state !== 'authorized' && r.state !== 'expired')
    throw new Error('Invalid backup state');
  return Object.freeze({ ...expected, state: r.state });
}
function backupTerms(
  selected: ReturnType<typeof parseBackupSelection>,
  input: BackupEnrollmentInput,
) {
  const compiled = prepareBackupEnrollment(input, input.validAfter);
  return {
    compiled,
    terms: {
      backup_id: selected.backupId,
      initialization_id: selected.consent.preparation.initialization_id,
      wallet_id: selected.walletId,
      wallet_account_id: selected.walletAccountId,
      proposal_hash: compiled.digest,
      expected_manifest_hash: compiled.expectedManifestHash,
      valid_after: input.validAfter,
      valid_until: input.validUntil,
      proposal_valid_until: selected.proposalValidUntil,
      ...assessment,
    },
  };
}

export function parseBackupPreview(value: unknown, choice: BackupSelection) {
  const selected = parseBackupSelection(choice),
    raw = object(value),
    input = backupInput(raw.input, selected);
  const { terms, compiled } = backupTerms(selected, input);
  fields(value, [...Object.keys(terms), 'state', 'input']);
  return Object.freeze({
    input,
    compiled,
    receipt: receipt(
      Object.fromEntries([...Object.keys(terms), 'state'].map((k) => [k, raw[k]])),
      terms,
    ),
  });
}
export function parseBackupReceipt(value: unknown, choice: BackupSelection, reviewed: unknown) {
  const preview = parseBackupPreview(reviewed, choice);
  return receipt(value, backupTerms(parseBackupSelection(choice), preview.input).terms);
}
function commitTerms(
  backupId: string,
  commitId: string,
  input: BackupEnrollmentInput,
  observed: BackupEnrollmentInput['observation'],
  after: number,
  until: number,
) {
  const compiled = prepareBackupCommit(input, observed, after, until, after);
  return {
    compiled,
    terms: {
      commit_id: parseResourceId('operation', commitId),
      backup_id: backupId,
      proposal_hash: compiled.prepared.digest,
      commit_digest: compiled.digest,
      valid_after: after,
      valid_until: until,
      ...assessment,
    },
  };
}
export function parseBackupCommitPreview(
  value: unknown,
  choice: BackupSelection,
  reviewed: unknown,
  commitId: string,
) {
  const selected = parseBackupSelection(choice),
    parent = parseBackupPreview(reviewed, selected),
    raw = object(value);
  if (parent.receipt.state !== 'authorized')
    throw new Error('Backup must be authorized before commit');
  equal(raw.input, parent.input);
  const observed = observation(raw.observation, parent.input.initialization, true);
  const { terms, compiled } = commitTerms(
    selected.backupId,
    commitId,
    parent.input,
    observed,
    time(raw.valid_after),
    time(raw.valid_until),
  );
  fields(value, [...Object.keys(terms), 'state', 'input', 'observation']);
  return Object.freeze({
    input: parent.input,
    observation: observed,
    compiled,
    receipt: receipt(
      Object.fromEntries([...Object.keys(terms), 'state'].map((k) => [k, raw[k]])),
      terms,
    ),
  });
}
export function parseBackupCommitReceipt(
  value: unknown,
  choice: BackupSelection,
  reviewed: unknown,
  commitReview: unknown,
  commitId: string,
) {
  const preview = parseBackupCommitPreview(commitReview, choice, reviewed, commitId);
  return receipt(
    value,
    commitTerms(
      choice.backupId,
      commitId,
      preview.input,
      preview.observation,
      preview.receipt.valid_after,
      preview.receipt.valid_until,
    ).terms,
  );
}
