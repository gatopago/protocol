import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestClient,
  erc20Abi,
  http,
  parseUnits,
  publicActions,
  walletActions,
  type Address,
} from 'viem';
import { monadTestnet } from 'viem/chains';
import { faucetCall } from '../packages/shared/assets';
import { walletNetworks } from '../packages/shared/networks';
import { quoteSettlement, settlementAllowed, settlementCalls } from '../packages/shared/settlement';
import { startFork } from './anvil';

const monad = walletNetworks['eip155:10143'];
const [ausd, ctk] = monad.tokens;
const forkClient = (url: string) =>
  createTestClient({ chain: monadTestnet, mode: 'anvil', transport: http(url) })
    .extend(publicActions)
    .extend(walletActions);
let fork: Awaited<ReturnType<typeof startFork>> | undefined;
let client: ReturnType<typeof forkClient>;

beforeAll(async () => {
  fork = await startFork(process.env.MONAD_TESTNET_RPC ?? 'https://testnet-rpc.monad.xyz');
  client = forkClient(fork.url);
}, 60_000);
afterAll(() => fork?.stop());

describe('Agora Instant Settlement on a Monad testnet fork', () => {
  it('sends AUSD that the recipient receives in the other coin, at the fixed price', async () => {
    const sender: Address = '0x00000000000000000000000000000000000000b0';
    const recipient: Address = '0x00000000000000000000000000000000000000c1';
    await client.setBalance({ address: sender, value: 10n ** 19n });
    await client.impersonateAccount({ address: sender });
    // The calls a GatoPago account batches into one operation, sent one by one by an address here.
    const run = async (calls: { to: Address; data: `0x${string}` }[]) => {
      for (const call of calls) {
        const hash = await client.sendTransaction({
          account: sender,
          chain: monadTestnet,
          ...call,
        });
        expect((await client.waitForTransactionReceipt({ hash })).status).toBe('success');
      }
    };
    await run([faucetCall(ausd.faucet!, sender)]);
    const amountIn = parseUnits('5', ausd.decimals);
    const quote = await quoteSettlement(client, monad, {
      tokenIn: ausd.address,
      tokenOut: ctk.address,
      amountIn,
    });
    // One AUSD for one test token, at the pair's price (no fee on testnet today).
    expect(quote).toBe(parseUnits('5', ctk.decimals));
    expect(await settlementAllowed(client, monad, sender)).toBe(false);
    const { timestamp } = await client.getBlock();
    await run(
      settlementCalls(monad, {
        account: sender,
        allowListed: false,
        tokenIn: ausd.address,
        tokenOut: ctk.address,
        amountIn,
        minOut: quote,
        recipient,
        now: timestamp,
      }),
    );
    expect(await settlementAllowed(client, monad, sender)).toBe(true);
    const balance = (token: Address, owner: Address) =>
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });
    expect(await balance(ctk.address, recipient)).toBe(quote);
    expect(await balance(ausd.address, recipient)).toBe(0n);
  }, 120_000);
});
