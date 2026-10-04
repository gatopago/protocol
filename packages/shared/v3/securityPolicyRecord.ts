import type { Hex } from 'viem';
import {
  validateSecurityPolicy,
  type SecurityPolicy,
  type SignerDescriptor,
} from './securityPolicy';

/** Public policy decoding only. Does not establish ownership or signing authority. */
export function parseSecurityPolicyRecord(value: unknown): SecurityPolicy {
  function row(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Invalid security policy record');
    return input as Record<string, unknown>;
  }
  function integer(input: unknown): number {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0)
      throw new Error('Invalid security policy integer');
    return input;
  }
  function hex(input: unknown): Hex {
    if (
      typeof input !== 'string' ||
      input.length > 258 ||
      !/^0x(?:[0-9a-f]{2})+$(?![\s\S])/.test(input)
    )
      throw new Error('Invalid security policy hex');
    return input as Hex;
  }
  const p = row(value);
  if ('recoveryThreshold' in p || 'recoveryDelaySeconds' in p)
    throw new Error('Retired policy format');
  if (!Array.isArray(p.signers) || p.signers.length > 16 || p.mode !== 'active')
    throw new Error('Invalid security policy policy');
  const signers = p.signers.map((value: unknown): SignerDescriptor => {
    const s = row(value),
      kind = integer(s.kind);
    if (kind !== 0 && kind !== 1 && kind !== 2) throw new Error('Invalid security policy signer');
    if ('assisted' in s) throw new Error('Retired signer format');
    return {
      kind,
      verifier: hex(s.verifier),
      verifierCodeHash: hex(s.verifierCodeHash),
      key: hex(s.key),
      roles: integer(s.roles),
    };
  });
  const policy: SecurityPolicy = {
    mode: p.mode,
    signers,
    spendThreshold: integer(p.spendThreshold),
    adminThreshold: integer(p.adminThreshold),
    upgradeDelaySeconds: integer(p.upgradeDelaySeconds),
  };
  validateSecurityPolicy(policy);
  return policy;
}
