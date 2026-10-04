export const paymentAuthorizationTypes = {
  PaymentAuthorization: [
    { name: 'intentId', type: 'bytes32' },
    { name: 'attemptId', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'merchant', type: 'address' },
    { name: 'settlementAmount', type: 'uint256' },
    { name: 'platformFee', type: 'uint256' },
    { name: 'validAfter', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
    { name: 'metadataHash', type: 'bytes32' },
  ],
} as const;

export const cctpPaymentAuthorizationTypes = {
  CctpPaymentAuthorization: [
    { name: 'intentId', type: 'bytes32' },
    { name: 'attemptId', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'merchant', type: 'address' },
    { name: 'settlementChainId', type: 'uint256' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'settlementAmount', type: 'uint256' },
    { name: 'grossPayerAmount', type: 'uint256' },
    { name: 'platformFee', type: 'uint256' },
    { name: 'maxCctpFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' },
    { name: 'validAfter', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
    { name: 'metadataHash', type: 'bytes32' },
  ],
} as const;

export const paymentAuthorizationDomain = {
  name: 'GatoPago Payment Router',
  version: '2',
} as const;

export const cctpPaymentAuthorizationDomain = {
  name: 'GatoPago CCTP Payment Router',
  version: '1',
} as const;
