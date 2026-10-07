import { afterEach, describe, expect, it, vi } from 'vitest';
import { crosschainCalls, crosschainFee, crosschainStatus } from '../packages/shared/crosschain';
import { walletNetworks } from '../packages/shared/networks';

const [arbitrum, fuji] = [walletNetworks['eip155:421614'], walletNetworks['eip155:43113']];
afterEach(() => vi.unstubAllGlobals());

describe('CCTP transfers', () => {
  it('prices the Fast protocol fee (rounded up) plus the forwarding fee', async () => {
    const fetch = vi.fn(async () =>
      Response.json([
        { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 1, med: 2, high: 50_000 } },
        { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 1, med: 2, high: 40_000 } },
      ]),
    );
    vi.stubGlobal('fetch', fetch);
    // 1.3 bps of 100.000001 USDC is 13000.00013 units: 13001.
    expect(await crosschainFee(arbitrum, fuji, 100_000_001n)).toBe(13_001n + 50_000n);
    expect(fetch).toHaveBeenCalledWith(
      'https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/3/1?forward=true',
      { signal: undefined },
    );
    // Avalanche has no Fast Transfer: Standard, without protocol fee.
    expect(await crosschainFee(fuji, arbitrum, 100_000_001n)).toBe(40_000n);
  });

  it('refuses an amount that the fee would consume', () => {
    expect(() =>
      crosschainCalls({
        from: arbitrum,
        to: fuji,
        amount: 100n,
        recipient: arbitrum.usdc,
        maxFee: 100n,
      }),
    ).toThrow('CCTP_AMOUNT_BELOW_FEE');
  });

  it('follows a crossing from the burn to the destination mint', async () => {
    const hash = `0x${'ab'.repeat(32)}` as const;
    const answers = [
      new Response(null, { status: 404 }),
      Response.json({ messages: [{ status: 'pending_confirmations' }] }),
      Response.json({
        messages: [
          { status: 'complete', message: '0x01', attestation: '0x02', forwardState: 'PENDING' },
        ],
      }),
      Response.json({
        messages: [{ status: 'complete', forwardState: 'CONFIRMED', forwardTxHash: hash }],
      }),
      Response.json({
        messages: [{ status: 'complete', forwardState: 'COMPLETE', forwardTxHash: hash }],
      }),
      Response.json({ messages: [{ status: 'complete', forwardState: 'FAILED' }] }),
    ];
    const fetch = vi.fn(async () => answers.shift()!);
    vi.stubGlobal('fetch', fetch);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push(await crosschainStatus(arbitrum, hash));
    expect(statuses[2].attested).toEqual({ message: '0x01', attestation: '0x02' });
    expect(statuses.map((status) => status.stage)).toEqual([
      'burned',
      'burned',
      'attested',
      'delivered',
      'delivered',
      'failed',
    ]);
    expect(fetch).toHaveBeenCalledWith(
      `https://iris-api-sandbox.circle.com/v2/messages/3?transactionHash=${hash}`,
      { signal: undefined },
    );
  });
});
