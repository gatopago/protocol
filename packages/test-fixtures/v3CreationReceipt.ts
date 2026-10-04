import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { vi } from 'vitest';
import { hashSecurityManifest } from '@gatopago/shared/v3/authorizations';
import {
  authorizeCreationOperation,
  prepareCreationOperation,
} from '@gatopago/shared/v3/creation-operation';
import { creationReceiptAbi } from '@gatopago/shared/v3/creation-receipt';
import { deploymentDocumentDigest } from '@gatopago/shared/v3/deployment';
import { prepareInitialization } from '@gatopago/shared/v3/initialization';
import { creationInspectionScenario } from './v3CreationInspection';
import { initializationFixture } from './v3Initialization';
import { fixtureHash } from './v3Inspection';

/** Synthetic chain evidence and ephemeral real signatures, never an admitted network. */
function creationReceiptData(
  prettyProfile = false,
  restored?: ReturnType<typeof authorizeCreationOperation>,
) {
  const f = initializationFixture(),
    inspection = creationInspectionScenario();
  const document = prettyProfile
    ? JSON.stringify(inspection.profile, null, 2)
    : inspection.input.document;
  const input = { ...f.input, document, expectedDigest: deploymentDocumentDigest(document) };
  const initialProof = f.assertion(prepareInitialization(input).digest);
  const gas = {
    verificationGasLimit: 2_000_000n,
    callGasLimit: 100_000n,
    preVerificationGas: 150_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 0n,
    maximumGasCharge: 2_250_000_000_000_000n,
  };
  const candidate = prepareCreationOperation(input, initialProof, gas, input.validAfter);
  const signed =
    restored ??
    authorizeCreationOperation(
      input,
      initialProof,
      gas,
      f.assertion(candidate.digest),
      input.validAfter,
    );
  const prepared = signed.prepared,
    transactionHash = fixtureHash('c'),
    account = signed.operation.sender;
  const manifest = hashSecurityManifest({
    accountId: prepared.message.accountId,
    generation: 3,
    securityVersion: 1n,
    previousManifestHash: zeroHash,
    policyHash: prepared.message.initialSecurityCommitment,
    chainScopeHash: prepared.message.chainScopeHash,
  });
  function log(address: Address, topics: readonly unknown[], data: Hex, index: number) {
    return {
      address,
      topics: [...topics] as Hex[],
      data,
      logIndex: toHex(index),
      transactionHash,
      transactionIndex: '0x2',
      blockHash: inspection.input.checkpoint.block_hash,
      blockNumber: '0x64',
      removed: false,
    };
  }
  const receipt = {
    status: '0x1',
    transactionHash,
    transactionIndex: '0x2',
    blockHash: inspection.input.checkpoint.block_hash,
    blockNumber: '0x64',
    logs: [
      log(
        account,
        encodeEventTopics({
          abi: creationReceiptAbi,
          eventName: 'AccountInitialized',
          args: { accountId: prepared.message.accountId },
        }),
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'bytes32' }],
          [manifest, prepared.digest],
        ),
        3,
      ),
      log(
        prepared.message.factory,
        encodeEventTopics({
          abi: creationReceiptAbi,
          eventName: 'AccountCreated',
          args: { accountId: prepared.message.accountId, account },
        }),
        prepared.message.initialSecurityCommitment,
        4,
      ),
      log(
        prepared.message.entryPoint,
        encodeEventTopics({
          abi: creationReceiptAbi,
          eventName: 'AccountDeployed',
          args: { userOpHash: signed.userOpHash, sender: account },
        }),
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'address' }],
          [prepared.message.factory, zeroAddress],
        ),
        5,
      ),
      log(
        account,
        encodeEventTopics({ abi: creationReceiptAbi, eventName: 'CreationCompleted' }),
        '0x',
        7,
      ),
      log(
        prepared.message.entryPoint,
        encodeEventTopics({
          abi: creationReceiptAbi,
          eventName: 'UserOperationEvent',
          args: { userOpHash: signed.userOpHash, sender: account, paymaster: zeroAddress },
        }),
        encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
          [0n, true, 12345n, 123n],
        ),
        8,
      ),
    ],
  };
  const state = {
    receipt,
    missing: false,
    timestamp: BigInt(signed.prepared.message.validAfter),
    proxyCode: '0x6005' as Hex,
  };
  const request = vi.fn(
    async (call: { method: string; params?: readonly unknown[] }): Promise<unknown> => {
      if (call.method === 'eth_getTransactionReceipt') {
        if (call.params?.[0] !== transactionHash) throw new Error('Unexpected receipt candidate');
        return state.missing ? null : state.receipt;
      }
      if (call.method === 'eth_getCode' && call.params?.[0] === account) return state.proxyCode;
      const result = await inspection.request(call);
      if (call.method === 'eth_getBlockByNumber')
        return { ...(result as Record<string, unknown>), timestamp: toHex(state.timestamp) };
      return result;
    },
  );
  return { input, signed, transactionHash, receipt, state, request, inspection };
}

export function creationReceiptScenario(
  prettyProfile = false,
  restored?: ReturnType<typeof authorizeCreationOperation>,
): ReturnType<typeof creationReceiptData> & { client: PublicClient } {
  const data = creationReceiptData(prettyProfile, restored);
  const client: PublicClient = createPublicClient({
    transport: custom({ request: data.request }, { retryCount: 0 }),
    cacheTime: 0,
    ccipRead: false,
  });
  return { ...data, client };
}
