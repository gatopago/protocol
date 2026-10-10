import { Asset, Keypair, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from 'viem';
import { privateKeyToAddress, generatePrivateKey } from 'viem/accounts';
import { crosschainFee } from '../packages/shared/crosschain';
import { stellarNetworks, walletContracts, walletNetworks } from '../packages/shared/networks';
import {
  addSignerOperation,
  burnMessage,
  crosschainOperation,
  deployAccountOperation,
  forwardRecipientHook,
  hookRecipient,
  prepareStellarCall,
  sendStellarOperation,
  signStellarAuth,
  signedStellarCall,
  isStellarKeySigner,
  signerChangeOperations,
  signedCallOperation,
  stellarAccountAddress,
  stellarAccountExists,
  stellarBurnAllowance,
  type StellarKey,
  stellarSigner,
  stellarNonceUsed,
  stellarBalance,
  stellarUsdcBalance,
  transferOperation,
} from '../packages/shared/stellar';
import { stellarKeyFromSeed } from '../packages/shared/passkey';
import { passkeyOwner } from '../packages/shared/wallet';
import { softwarePasskey } from './passkey';

const testnet = stellarNetworks['stellar:testnet'];
const arbitrum = walletNetworks['eip155:421614'];
afterEach(() => vi.unstubAllGlobals());

/** An Ed25519 key that signs like a Mera session, from a Stellar keypair. */
const ed25519Key = (keypair = Keypair.random()): StellarKey => ({
  type: 'ed25519',
  publicKey: bytesToHex(keypair.rawPublicKey()),
  signMessage: async (message) => keypair.sign(Buffer.from(message)),
});

describe('Stellar keys from a recovery phrase', () => {
  it("derive SEP-5's first account", async () => {
    // SEP-5 test vector 1; BIP-39 seed = PBKDF2-HMAC-SHA512(phrase, 'mnemonic', 2048).
    const phrase = 'illness spike retreat truth genius clock brain pass fit cave bargain toe';
    const encoder = new TextEncoder();
    const seed = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-512', salt: encoder.encode('mnemonic'), iterations: 2048 },
        await crypto.subtle.importKey('raw', encoder.encode(phrase), 'PBKDF2', false, [
          'deriveBits',
        ]),
        512,
      ),
    );
    const key = Keypair.fromRawEd25519Seed(Buffer.from(await stellarKeyFromSeed(seed)));
    expect(key.publicKey()).toBe('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6');
  });
});

describe('Stellar accounts', () => {
  it('derive from the deployer and the EVM account address', () => {
    // Deployed on testnet by the 10a spike.
    expect(
      stellarAccountAddress(
        testnet,
        'GCHDT4ZG7SY5MHC4YZJH7QLN3OEHQD7SKRPX6GGVZ67SVFTQ5L5ABXTC',
        '0x59911e0ccff8076bd4f32c94bb2b0eae603cec55',
      ),
    ).toBe('CAGJXUQ3OQQJVIUW773L44CYXJYS6AEQCTFO7SGRDCAORGMFGIAFQZA7');
  });

  it('mirror only passkey owners', () => {
    const key = softwarePasskey().publicKey;
    expect(stellarSigner(testnet, passkeyOwner(walletContracts.webAuthnVerifier, key))).not.toBe(
      null,
    );
    expect(stellarSigner(testnet, passkeyOwner(arbitrum.usdc, key))).toBe(null);
  });
});

describe('CCTP with Stellar', () => {
  it('encodes the CctpForwarder recipient hook', () => {
    // The hook of the 10a spike's Arbitrum → Stellar burn.
    expect(forwardRecipientHook('CAGJXUQ3OQQJVIUW773L44CYXJYS6AEQCTFO7SGRDCAORGMFGIAFQZA7')).toBe(
      '0x00000000000000000000000000000000000000000000000000000000000000384341474a585551334f51514a564955573737334c34344359584a5953364145514354464f375347524443414f52474d4647494146515a4137',
    );
    expect(() => forwardRecipientHook('0x75464f762bc50d0A0B127ab5a085504BF102Bb88')).toThrow(
      'INVALID_STELLAR_ADDRESS',
    );
    // And read back, as a relayer finds it in a burn.
    const recipient = 'CAGJXUQ3OQQJVIUW773L44CYXJYS6AEQCTFO7SGRDCAORGMFGIAFQZA7';
    expect(hookRecipient(forwardRecipientHook(recipient))).toBe(recipient);
    expect(hookRecipient('0x')).toBeNull();
  });

  it('reads who burned toward which Stellar recipient', () => {
    // Iris message of the 10b check: 0x75 burned 1 USDC on Arbitrum Sepolia toward Stellar.
    expect(
      burnMessage(
        '0x00000001000000030000001b738d171da655afc22ca3e9bcea81ff84454200ce440c0d5254da12654a3f63c10000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daada6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b83de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e000003e8000003e80000000100000000000000000000000075faf114eafb1bdbe2f0316df893fd58ce46aa4d3de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e00000000000000000000000000000000000000000000000000000000000f424000000000000000000000000075464f762bc50d0a0b127ab5a085504bf102bb880000000000000000000000000000000000000000000000000000000000000082000000000000000000000000000000000000000000000000000000000000008200000000000000000000000000000000000000000000000000000000004d5c6a000000000000000000000000000000000000000000000000000000000000003843435942413344484d584f5a49484e4a4b43325644505144345758593347345457575042324155353747543551474942555141444e543351',
      ),
    ).toEqual({
      destinationDomain: 27,
      amount: 1_000_000n,
      sender: '0x75464f762bc50d0A0B127ab5a085504BF102Bb88',
      recipient: 'CCYBA3DHMXOZIHNJKC2VDPQD4WXY3G4TWWPB2AU57GT5QGIBUQADNT3Q',
    });
  });

  it('prices toward Stellar without the Forwarding Service', async () => {
    const fetch = vi.fn(async () =>
      Response.json([
        { finalityThreshold: 1000, minimumFee: 1.3 },
        { finalityThreshold: 2000, minimumFee: 0 },
      ]),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await crosschainFee(arbitrum, testnet, 100_000_001n)).toBe(13_001n);
    expect(fetch).toHaveBeenCalledWith(
      'https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/3/27',
      { signal: undefined },
    );
  });

  it('refuses a burn that the fee would consume', () => {
    expect(() =>
      crosschainOperation(testnet, {
        account: 'CAGJXUQ3OQQJVIUW773L44CYXJYS6AEQCTFO7SGRDCAORGMFGIAFQZA7',
        to: arbitrum,
        amount: 2_500_000n, // 0.25 USDC in 7 decimals
        recipient: '0x75464f762bc50d0A0B127ab5a085504BF102Bb88',
        maxFee: 250_000n, // 0.25 USDC in 6 decimals
      }),
    ).toThrow('CCTP_AMOUNT_BELOW_FEE');
  });
});

// Stellar has no forks: these run on testnet, with XLM's asset contract standing in for USDC.
describe('Stellar accounts on testnet', { timeout: 180_000 }, () => {
  const server = new rpc.Server(testnet.rpcUrl);
  const network = { ...testnet, usdc: testnet.xlm };

  it('receive before existing, then any of their passkeys signs', async () => {
    const sponsor = Keypair.random();
    expect((await fetch(`https://friendbot.stellar.org?addr=${sponsor.publicKey()}`)).ok).toBe(
      true,
    );
    const [phone, backup, laptop] = [softwarePasskey(), softwarePasskey(), softwarePasskey()];
    const owner = (key: { publicKey: `0x${string}` }) =>
      passkeyOwner(walletContracts.webAuthnVerifier, key.publicKey);
    const evm = privateKeyToAddress(generatePrivateKey());
    const account = stellarAccountAddress(network, sponsor.publicKey(), evm);

    const send = (operation: Parameters<typeof sendStellarOperation>[3]) =>
      sendStellarOperation(server, network, sponsor, operation);
    const signed = async (
      operation: Parameters<typeof prepareStellarCall>[3],
      key: ReturnType<typeof softwarePasskey>,
    ) => {
      const call = await prepareStellarCall(server, network, sponsor.publicKey(), operation);
      const auth = await signStellarAuth(network, call.auth, {
        owner: key,
        validUntil: call.latestLedger + 60,
      });
      return send(signedCallOperation(call.func, auth));
    };

    expect(await stellarAccountExists(server, account)).toBe(false);
    await send(transferOperation(network, sponsor.publicKey(), account, 30_000_000n));
    expect(await stellarUsdcBalance(server, network, account)).toBe(30_000_000n);

    const deployed = await send(
      deployAccountOperation(network, sponsor.publicKey(), evm, [owner(phone), owner(backup)]),
    );
    expect(scValToNative(deployed.returnValue!)).toBe(account);
    expect(await stellarUsdcBalance(server, network, account)).toBe(30_000_000n);
    expect(await stellarAccountExists(server, account)).toBe(true);
    expect(await stellarBurnAllowance(server, network, account)).toBe(0n);

    await signed(transferOperation(network, account, sponsor.publicKey(), 10_000_000n), backup);
    await signed(addSignerOperation(network, account, owner(laptop)), phone);
    await signed(transferOperation(network, account, sponsor.publicKey(), 10_000_000n), laptop);
    expect(await stellarUsdcBalance(server, network, account)).toBe(10_000_000n);

    // An account that does not exist cannot hold XLM: its balance cannot be read.
    await expect(
      stellarBalance(server, network, network.xlm, Keypair.random().publicKey()),
    ).rejects.toThrow('STELLAR_READ_FAILED');
    expect(network.xlm).toBe(Asset.native().contractId(network.passphrase));

    // A key that is not a signer cannot move funds.
    await expect(
      signed(transferOperation(network, account, sponsor.publicKey(), 1n), softwarePasskey()),
    ).rejects.toThrow();

    // The EVM account removed `backup`: the Stellar account follows, adding before removing.
    const changes = await signerChangeOperations(server, network, account, [
      owner(phone),
      owner(laptop),
    ]);
    expect(changes).toHaveLength(1);
    for (const change of changes) await signed(change, laptop);
    expect(
      await signerChangeOperations(server, network, account, [owner(phone), owner(laptop)]),
    ).toEqual([]);
    await expect(
      signed(transferOperation(network, account, sponsor.publicKey(), 1n), backup),
    ).rejects.toThrow();

    // What the app sends through Wallet Core, and how it finds out the call landed.
    const call = await signedStellarCall(server, network, {
      sponsor: sponsor.publicKey(),
      operation: transferOperation(network, account, sponsor.publicKey(), 1_000_000n),
      owner: phone,
    });
    expect(await stellarNonceUsed(server, account, call.nonces[0])).toBe(false);
    await send(
      signedCallOperation(
        xdr.HostFunction.fromXdr(call.func, 'base64'),
        call.auth.map((entry) => xdr.SorobanAuthorizationEntry.fromXdr(entry, 'base64')),
      ),
    );
    expect(await stellarNonceUsed(server, account, call.nonces[0])).toBe(true);
    expect(await stellarUsdcBalance(server, network, account)).toBe(9_000_000n);
  });

  it('are signed by an Ed25519 key alone, as Mera accounts are', async () => {
    const sponsor = Keypair.random();
    expect((await fetch(`https://friendbot.stellar.org?addr=${sponsor.publicKey()}`)).ok).toBe(
      true,
    );
    const [mera, stranger, phone] = [ed25519Key(), ed25519Key(), softwarePasskey()];
    const evm = privateKeyToAddress(generatePrivateKey());
    const account = stellarAccountAddress(network, sponsor.publicKey(), evm);
    const send = (operation: Parameters<typeof sendStellarOperation>[3]) =>
      sendStellarOperation(server, network, sponsor, operation);
    const signed = async (operation: Parameters<typeof prepareStellarCall>[3], key: StellarKey) => {
      const call = await prepareStellarCall(server, network, sponsor.publicKey(), operation);
      const auth = await signStellarAuth(network, call.auth, {
        owner: key,
        validUntil: call.latestLedger + 60,
      });
      return send(signedCallOperation(call.func, auth));
    };

    await send(transferOperation(network, sponsor.publicKey(), account, 20_000_000n));
    // No passkey owner: the EVM account is owned by Mera's EVM key, and this is its Stellar key.
    await send(deployAccountOperation(network, sponsor.publicKey(), evm, [], [mera.publicKey]));
    await signed(transferOperation(network, account, sponsor.publicKey(), 5_000_000n), mera);
    expect(await stellarUsdcBalance(server, network, account)).toBe(15_000_000n);
    await expect(
      signed(transferOperation(network, account, sponsor.publicKey(), 1n), stranger),
    ).rejects.toThrow();
    // Only the key the account was created with signs for it.
    expect(await isStellarKeySigner(server, network, account, mera.publicKey)).toBe(true);
    expect(await isStellarKeySigner(server, network, account, stranger.publicKey)).toBe(false);

    // A passkey approved later joins; the Mera key stays.
    const phoneOwner = passkeyOwner(walletContracts.webAuthnVerifier, phone.publicKey);
    const changes = await signerChangeOperations(
      server,
      network,
      account,
      [phoneOwner],
      [mera.publicKey],
    );
    expect(changes).toHaveLength(1);
    await signed(changes[0], mera);
    await signed(transferOperation(network, account, sponsor.publicKey(), 5_000_000n), phone);
    expect(await stellarUsdcBalance(server, network, account)).toBe(10_000_000n);
  });
});
