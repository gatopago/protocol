export type FeeBearer = 'none' | 'payer';

export type PaymentFeeSnapshot = {
  policyId: string;
  policyVersion: number;
  ruleId: string;
  platformFeeBps: number;
  platformFeeBearer: FeeBearer;
  platformFeeRecipient: `0x${string}` | null;
  routeFeeCapBps: number;
};

export type PaymentFeeLine = {
  type: 'platform' | 'network';
  bearer: FeeBearer;
  quotedAmountAtomic: string;
  actualAmountAtomic: string | null;
  recipient: `0x${string}` | null;
  status: 'quoted' | 'waived' | 'charged';
  policyId: string;
  policyVersion: number;
  ruleId: string;
};

export type PaymentFeeBreakdown = {
  currency: 'USDC';
  platform: PaymentFeeLine;
  network: PaymentFeeLine;
  totalQuotedAtomic: string;
  totalActualAtomic: string | null;
};

export const FREE_PAYMENT_FEE_SNAPSHOT: PaymentFeeSnapshot = {
  policyId: 'free-default',
  policyVersion: 1,
  ruleId: 'free-default',
  platformFeeBps: 0,
  platformFeeBearer: 'none',
  platformFeeRecipient: null,
  routeFeeCapBps: 0,
};
