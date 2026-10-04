import { parseResourceId } from './v3/primitives';

export const PAYMENTS_CONTRACT_VERSION = 3 as const;
export const PAYMENT_JOB_MESSAGE_VERSION = 2 as const;

export type WalletServiceClaim = {
  service: 'gatopago-wallet-core';
  requestId: string;
  userId: string;
};

export type SettlementAccountCommand = {
  contractVersion: 3;
  commandId: string;
  claim: WalletServiceClaim;
  accountVersion: number;
  walletAddress: string;
  chainId: number;
};

export type ReserveWalletPaymentAttemptCommand = {
  contractVersion: 3;
  commandId: string;
  claim: WalletServiceClaim;
  linkId: string;
  payerAddress: string;
  sourceChainId: number;
  requestedRoute: 'local';

  amount?: string;
};

export type RegisterWalletPaymentExecutionCommand = {
  contractVersion: 3;
  commandId: string;
  claim: WalletServiceClaim;
  attemptId: string;
  userOpHash: string;
  sourceChainId: number;
};

export type RpcErrorCode =
  | 'INVALID_CONTRACT'
  | 'INVALID_CLAIM'
  | 'INVALID_COMMAND'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAVAILABLE';

export type RpcResult<T> =
  | { ok: true; contractVersion: 3; value: T }
  | { ok: false; contractVersion: 3; error: RpcErrorCode; message: string };

export type SettlementAccountResult = {
  merchantId: string;
  accountVersion: number;
  applied: boolean;
};

export type SerializedPaymentAuthorization = {
  intentId: `0x${string}`;
  attemptId: `0x${string}`;
  payer: `0x${string}`;
  merchant: `0x${string}`;
  settlementAmount: string;
  platformFee: string;
  validAfter: number;
  validUntil: number;
  metadataHash: `0x${string}`;
};

export type ReservedWalletPaymentAttempt = {
  attemptId: string;
  intentId: string;
  linkId: string;
  merchant: `0x${string}`;
  amount: string;
  currency: 'USDC';
  sourceChainId: number;
  router: `0x${string}`;
  authorization: SerializedPaymentAuthorization;
  signature: `0x${string}`;
  authorizationHash: `0x${string}`;
  expiresAt: string;
};

export type RegisteredWalletPaymentExecution = {
  attemptId: string;
  status: 'submitted' | 'processing' | 'paid';
  userOpHash: string;
  idempotentReplay: boolean;
};

export interface PaymentsRpcService {
  contractVersion(): number | Promise<number>;
  upsertSettlementAccount(
    command: SettlementAccountCommand,
  ): Promise<RpcResult<SettlementAccountResult>>;
  reserveWalletPaymentAttempt(
    command: ReserveWalletPaymentAttemptCommand,
  ): Promise<RpcResult<ReservedWalletPaymentAttempt>>;
  registerWalletPaymentExecution(
    command: RegisterWalletPaymentExecutionCommand,
  ): Promise<RpcResult<RegisteredWalletPaymentExecution>>;
}

export type PaymentJobName =
  'attempt_reconcile' | 'cctp_attestation' | 'cctp_mint' | 'router_watch' | 'webhook_delivery';

export type PaymentJobMessage = {
  messageVersion: 2;
  job: PaymentJobName;
  jobId: string;
  dedupeKey: string;
  resourceId: string;
  partition: string;
  attempt: number;
  createdAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function safeDate(value: unknown): string | null {
  const text = safeText(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

const PAYMENT_JOB_NAMES = new Set<PaymentJobName>([
  'attempt_reconcile',
  'cctp_attestation',
  'cctp_mint',
  'router_watch',
  'webhook_delivery',
]);

export function parsePaymentJobMessage(value: unknown): PaymentJobMessage | null {
  if (!isRecord(value)) return null;
  const job = value.job;
  if (typeof job !== 'string' || !PAYMENT_JOB_NAMES.has(job as PaymentJobName)) return null;
  const jobId = safeText(value.jobId, 160);
  const resourceId = safeText(value.resourceId, 160);
  const createdAt = safeDate(value.createdAt);
  if (!jobId || !resourceId || !createdAt) return null;

  if (value.messageVersion !== 2) return null;
  const dedupeKey = safeText(value.dedupeKey, 200);
  const partition = safeText(value.partition, 160);
  if (
    !dedupeKey ||
    !partition ||
    typeof value.attempt !== 'number' ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0
  )
    return null;
  return {
    messageVersion: 2,
    job: job as PaymentJobName,
    jobId,
    dedupeKey,
    resourceId,
    partition,
    attempt: value.attempt,
    createdAt,
  };
}

export function isWalletServiceClaim(value: unknown): value is WalletServiceClaim {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'requestId,service,userId' ||
    value.service !== 'gatopago-wallet-core' ||
    !safeText(value.requestId, 160)
  )
    return false;
  try {
    parseResourceId('user', value.userId);
    return true;
  } catch {
    return false;
  }
}

export function isSupportedPaymentsContractVersion(value: unknown): value is 3 {
  return value === PAYMENTS_CONTRACT_VERSION;
}

function currentCommand(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    isSupportedPaymentsContractVersion(value.contractVersion) &&
    isWalletServiceClaim(value.claim) &&
    !!safeText(value.commandId, 200)
  );
}
function chainId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function isSettlementAccountCommand(value: unknown): value is SettlementAccountCommand {
  return (
    currentCommand(value) &&
    chainId(value.accountVersion) &&
    chainId(value.chainId) &&
    !!safeText(value.walletAddress, 42)
  );
}
export function isReserveWalletPaymentAttemptCommand(
  value: unknown,
): value is ReserveWalletPaymentAttemptCommand {
  return (
    currentCommand(value) &&
    chainId(value.sourceChainId) &&
    value.requestedRoute === 'local' &&
    !!safeText(value.linkId, 160) &&
    !!safeText(value.payerAddress, 42) &&
    (value.amount === undefined || !!safeText(value.amount, 80))
  );
}
export function isRegisterWalletPaymentExecutionCommand(
  value: unknown,
): value is RegisterWalletPaymentExecutionCommand {
  return (
    currentCommand(value) &&
    chainId(value.sourceChainId) &&
    !!safeText(value.attemptId, 160) &&
    typeof value.userOpHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/u.test(value.userOpHash)
  );
}
