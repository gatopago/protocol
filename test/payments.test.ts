import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseEventLogs,
  parseUnits,
  publicActions,
  toHex,
  walletActions,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { faucetCall } from '../packages/shared/assets';
import { walletNetworks } from '../packages/shared/networks';
import {
  paymentCalls,
  paymentPermit,
  paymentRouterAbi,
  paymentTypedData,
  payWithPermitCall,
} from '../packages/shared/payments';

const PORT = 8798;
const monad = walletNetworks['eip155:10143'];
const [ausd] = monad.tokens;
let anvil: ChildProcess;
const client = createTestClient({
  chain: monadTestnet,
  mode: 'anvil',
  transport: http(`http://127.0.0.1:${PORT}`),
})
  .extend(publicActions)
  .extend(walletActions);

beforeAll(async () => {
  anvil = spawn(
    'anvil',
    [
      '--fork-url',
      process.env.MONAD_TESTNET_RPC ?? 'https://testnet-rpc.monad.xyz',
      '--port',
      String(PORT),
      '--silent',
    ],
    { stdio: 'ignore' },
  );
  for (let attempt = 0; ; attempt++) {
    try {
      await client.getChainId();
      return;
    } catch (error) {
      if (attempt > 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}, 60_000);
afterAll(() => anvil?.kill());

const balance = (token: Address, owner: Address) =>
  client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });

describe('Flow payments in AUSD on a Monad testnet fork', () => {
  it('pays in AUSD where it is received, with an allowance and with a permit', async () => {
    const deployer: Address = '0x00000000000000000000000000000000000000d0';
    const payer: Address = '0x00000000000000000000000000000000000000b0';
    const merchant: Address = '0x00000000000000000000000000000000000000c1';
    const treasury: Address = '0x000000000000000000000000000000000000fee5';
    const flowSigner = privateKeyToAccount(generatePrivateKey());
    for (const address of [deployer, payer]) {
      await client.setBalance({ address, value: 10n ** 19n });
      await client.impersonateAccount({ address });
    }
    const json = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../contracts/out/GatoPagoPaymentRouter.sol/GatoPagoPaymentRouter.json',
        ),
        'utf8',
      ),
    );
    const deployed = await client.deployContract({
      account: deployer,
      chain: monadTestnet,
      abi: json.abi as Abi,
      bytecode: json.bytecode.object as Hex,
      args: [
        deployer,
        flowSigner.address,
        treasury,
        monad.usdc,
        monad.cctp.tokenMessenger,
        monad.cctp.domain,
      ],
    });
    const { contractAddress } = await client.waitForTransactionReceipt({ hash: deployed });
    const network = { ...monad, paymentRouter: contractAddress! };
    const send = async (from: Address, call: { to: Address; data: Hex }) => {
      const hash = await client.sendTransaction({ account: from, chain: monadTestnet, ...call });
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
      return receipt;
    };
    const payment = (intent: string, from: Address) => ({
      intentId: keccak256(toHex(intent)),
      payer: from,
      merchant,
      token: ausd.address,
      amount: parseUnits('5', ausd.decimals),
      fee: parseUnits('0.05', ausd.decimals),
      // AUSD stays on Monad: paid and received here.
      destinationDomain: monad.cctp.domain,
      maxCctpFee: 0n,
      minFinalityThreshold: 2000,
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });

    // A GatoPago account approves and pays in one operation; sent call by call here.
    await send(payer, faucetCall(ausd.faucet!, payer));
    const first = payment('pi_ausd', payer);
    let receipt;
    for (const call of paymentCalls(
      network,
      first,
      await flowSigner.signTypedData(paymentTypedData(network, first)),
    ))
      receipt = await send(payer, call);
    const [sent] = parseEventLogs({
      abi: paymentRouterAbi,
      eventName: 'PaymentSent',
      logs: receipt!.logs,
    });
    expect(sent.args).toMatchObject({ token: ausd.address, amount: first.amount, fee: first.fee });
    expect(await balance(ausd.address, merchant)).toBe(first.amount);
    expect(await balance(ausd.address, treasury)).toBe(first.fee);

    // A browser wallet signs an AUSD permit (its own EIP-712 domain, "Agora Dollar") and pays in one
    // transaction, leaving no allowance.
    const wallet = privateKeyToAccount(generatePrivateKey());
    await client.setBalance({ address: wallet.address, value: 10n ** 19n });
    // The faucet serves an address once in a while: the payer passes some on.
    await send(payer, {
      to: ausd.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [wallet.address, parseUnits('10', ausd.decimals)],
      }),
    });
    const second = payment('pi_ausd_wallet', wallet.address);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const permit = await wallet.signTypedData(
      await paymentPermit(client, network, {
        token: ausd.address,
        owner: wallet.address,
        value: second.amount + second.fee,
        deadline,
      }),
    );
    const hash = await client.sendTransaction({
      account: wallet,
      chain: monadTestnet,
      ...payWithPermitCall(
        network,
        second,
        await flowSigner.signTypedData(paymentTypedData(network, second)),
        {
          deadline,
          signature: permit,
        },
      ),
    });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe('success');
    expect(await balance(ausd.address, merchant)).toBe(2n * first.amount);
    expect(
      await client.readContract({
        address: ausd.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [wallet.address, network.paymentRouter],
      }),
    ).toBe(0n);
  }, 180_000);
});
