# GatoPago Protocol

GatoPago's onchain layer and the internal SDK that uses it.

- **Wallet:** ERC-4337 smart accounts (EntryPoint v0.9) controlled by passkeys, with sponsored gas
  and recovery through a second passkey, at the same address on every network.
- **Payments:** `GatoPagoPaymentRouter`, which pays GatoPago Flow payment intents in USDC on the
  same network or, through Circle CCTP, on another one.

See [SECURITY.md](SECURITY.md) for the trust model, keys and tested guarantees.

## Layout

```
contracts/            Foundry project
  src/wallet/         GatoPagoAccount, GatoPagoAccountFactory, GatoPagoPaymaster
  src/                GatoPagoPaymentRouter (Flow)
  script/             DeployWallet.s.sol (wallet) and DeployPayments.s.sol (router)
  test/
packages/shared/      @gatopago/shared: viem account adapter, bundler, networks, CCTP, payments, Aave, Uniswap, Stellar
test/                 End-to-end test on forks of real networks (viem + bundler) and on Stellar testnet
scripts/              SDK build and storage layout check
```

## Wallet

The contracts compose audited OpenZeppelin 5.7 components: `Account`, `MultiSignerERC7913`,
`ERC7913WebAuthnVerifier`, `ERC7821`, `ERC7739`, `UUPSUpgradeable`, `ERC1967Proxy` and
`PaymasterSigner`.

- **Account** (`GatoPagoAccount`): passkeys are the owners; any one of them is enough (threshold 1).
  - Normal channel: payments and calls, signed for one network. It never calls the account itself.
  - Approval channel: `applyApproval(sequence, call)` adds or removes owners or upgrades the account.
    It is signed once without the chain id and applies on every network, in order, even where the
    account does not exist yet. The sequence only advances when the change succeeds, so a failed
    attempt can be retried. Coinbase Smart Wallet's pattern, adapted to EntryPoint v0.9.
- **Factory**: ERC-1967 proxies through CREATE2; the address commits to the initial owners.
- **Paymaster**: pays gas for operations signed by the backend's sponsor key; daily budgets live
  off-chain.

In TypeScript, `@gatopago/shared/wallet` exposes `toGatoPagoAccount` (a viem smart account that also
signs messages and typed data per ERC-1271/7739, wrapped in ERC-6492 before deployment, so SIWE works
with viem's `verifySiweMessage`), `signApproval` / `encodeApplyApproval` / `verifyApproval` (recovery)
and the sponsorship signature. `@gatopago/shared/networks` is the single source of the supported
networks, their USDC, their Circle CCTP domain and the wallet contract addresses.
`@gatopago/shared/crosschain` moves USDC between them with CCTP V2: `crosschainFee` asks Circle for
the fee and `crosschainCalls` builds the approve and burn the account sends as one operation;
Circle's Forwarding Service mints on the destination, so no relayer of ours is involved.
`@gatopago/shared/stellar` extends an account to Stellar (see below).
`@gatopago/shared/passkey` is how a passkey identifies an account, shared by the app and the merchant
console so both always find the same one: `recoverPasskeyPublicKeys` recovers the passkey's key from
a WebAuthn signature and `passkeyAccount` matches it against an account's current owners, and
Mera's fixed recipe turns a passkey's PRF output into keys (`meraSeed`, `meraEvmKey` at
`m/44'/60'/0'/0/0`, `stellarKeyFromSeed` at SEP-5's `m/44'/148'/0'`). `capturingWebAuthnClient`
lets one prompt serve both: Mera gets its PRF output and the assertion is kept for
`passkeyAccount` (it types against `@category-labs/mera`, an optional peer dependency).
`@gatopago/shared/http` is what both Workers answer with: `HttpError` (`{ error_code }`), `json`,
`readJson` (a JSON object, reading at most a byte limit) and `withCors`.
`@gatopago/shared/bundler` is a minimal ERC-4337 bundler that only accepts GatoPago-sponsored
operations and speaks the standard RPC, so viem's `createBundlerClient` works unchanged. It simulates
each operation's execution gas and computes `preVerificationGas` from its bytes (plus L1 data on
Arbitrum with `l1Fees: 'arbitrum'`), so the gas charged to an operation is within a few percent of
the transaction's actual gas. `gatopagoGasConfig` holds the measured validation limits.

### Stellar

Stellar is a secondary network: an account gets a Stellar address that receives USDC and moves it
to and from the EVM networks with CCTP (domain 27). No contract of ours runs there.

- **Account**: an OpenZeppelin [`stellar-contracts`](https://github.com/OpenZeppelin/stellar-contracts)
  smart account (the WASM, WebAuthn verifier and threshold policy recorded by
  [stellar/smart-account-kit](https://github.com/stellar/smart-account-kit/blob/main/docs/deployments-protocol-27-2026-07-09.md)).
  Its signers are the EVM account's passkey owners and a threshold policy of 1 lets any one of
  them sign, as on EVM. `signerChangeOperations` lists the calls that make its signers the EVM
  account's current passkey owners and its approved Ed25519 keys (additions first, so it always
  keeps one). Ed25519 keys are what Mera derives from a passkey (`stellarKeyFromSeed` in
  `@gatopago/shared/passkey`, SEP-5's `m/44'/148'/0'`): an owner key of the EVM account approves each one (`stellarKeyApproval`) and
  the network's Ed25519 verifier checks its signatures.
- **Address**: derived from a deployer key and the EVM account address
  (`stellarAccountAddress`), so it works before the account exists and a backup passkey finds it
  through the EVM account. Only the deployer can create it (`deployAccountOperation`), which
  keeps anyone from claiming the address with other signers; the backend holds that key and pays
  fees with it.
- **Signing**: `signStellarAuth` signs the account's authorization entries with the same viem
  `WebAuthnAccount` used on EVM; `prepareStellarCall` simulates with the sponsor as source and
  `sendStellarOperation` sends with the sponsor paying. Apps use `signedStellarCall`, which does
  both and returns base64 XDR for the backend. Signatures last five minutes; until then
  `stellarNonceUsed` tells whether a call whose answer was lost landed.
- **Coins**: USDC and XLM (the network's own coin, `network.xlm`), both through their Stellar
  Asset Contracts: `transferOperation` takes the token (USDC by default) and `stellarBalance` reads
  either. `isStellarAddress` accepts accounts (`G…`) and contracts (`C…`). An account without a
  USDC trustline cannot receive USDC, one that does not exist cannot receive XLM, and the balance
  read fails for both.
- **CCTP**: from Stellar, `crosschainOperation` burns through Circle's TokenMessengerMinter and the
  Forwarding Service mints on the EVM network. The burn takes USDC with `transfer_from`, so
  `approveBurnsOperation` grants Circle's minter a long allowance once (Circle issues this USDC
  already) and each crossing is then one signature. Toward Stellar, `crosschainToStellarCalls`
  burns to Circle's CctpForwarder with the recipient in the hook; there is no Forwarding Service,
  so someone must send `mintAndForwardOperation` with the attested message that
  `crosschainStatus` returns. USDC has 7 decimals on Stellar; CCTP moves 6 and the seventh stays
  (`toStellarUnits`, `fromStellarUnits`).

### Deployed (testnets)

Same addresses on Arbitrum Sepolia (`eip155:421614`), Avalanche Fuji (`eip155:43113`) and Monad
testnet (`eip155:10143`). Transactions and blocks: [`contracts/deployments/wallet.json`](contracts/deployments/wallet.json).
Every contract, the payment routers included, is verified on [Sourcify](https://sourcify.dev)
(exact match); deployments pass `--verify --verifier sourcify`.

| Contract                         | Address                                      |
| -------------------------------- | -------------------------------------------- |
| EntryPoint v0.9 (canonical)      | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` |
| `ERC7913WebAuthnVerifier`        | `0x3BF33A59064bB8f9006bfF94A20Cc8917D7876E8` |
| `GatoPagoAccountFactory`         | `0x4A000246131C2DEd46ff6eA047808E708Fa0da02` |
| `GatoPagoAccount` implementation | `0xB3D5b3612163f29Ba02CDa566196BAc392B4Ff7D` |
| `GatoPagoPaymaster`              | `0x9EEE399a75C2C06b528E50f05fA6d61aAcE813b1` |

On testnets the paymaster's sponsor signer and owner, and the bundler relayer, are all
`0x75464f762bc50d0A0B127ab5a085504BF102Bb88`. Explorers: [Arbiscan](https://sepolia.arbiscan.io),
[Snowtrace](https://testnet.snowtrace.io), [Monad Explorer](https://testnet.monadexplorer.com).

### Deploying

The same command produces the same addresses on every network, so adding a network is running it
there (contracts already deployed are skipped):

```sh
cd contracts
export GATOPAGO_SPONSOR_SIGNER=0x… GATOPAGO_PAYMASTER_OWNER=0x…
GATOPAGO_PAYMASTER_DEPOSIT=<wei> forge script script/DeployWallet.s.sol \
  --rpc-url <network> --account <foundry keystore> --broadcast --verify --verifier sourcify
```

The sponsor signer and the paymaster owner are part of the paymaster address: keep them identical
on every network (mainnet will use separate keys, hence a different paymaster address). The owner
can withdraw the deposit; use a cold key or a multisig. Afterwards record the transactions in
`contracts/deployments/wallet.json` and, if an address changed, `packages/shared/networks.ts`
(`test/networks.test.ts` fails until both match the compiled contracts).

## Payments

`GatoPagoPaymentRouter` pays a Flow payment intent as Flow's signer authorized it (EIP-712): the
payer must be the caller, each intent is paid once and the authorization expires. The merchant
receives `amount` on the same network or, when `destinationDomain` is another Circle domain, the
router burns with CCTP V2 and requests Circle's Forwarding Service, which mints to the merchant.
The payer also pays the platform fee and the CCTP fee ceiling. `payWithPermit` lets an external
wallet pay in one transaction. `@gatopago/shared/payments` builds the typed data Flow signs, the
calls a GatoPago account sends, and for an external wallet the EIP-2612 permit it signs
(`paymentPermit`, read from Circle's USDC) and the one call that spends it (`payWithPermitCall`).

| Network          | `GatoPagoPaymentRouter`                      |
| ---------------- | -------------------------------------------- |
| Arbitrum Sepolia | `0x1536b89c24b4c5296Ea67d3a5d0BFB7a3dc1c792` |
| Avalanche Fuji   | `0x52a0a15d762eB68092b5B45D958C4244233b7F58` |
| Monad testnet    | `0x18F716B0CCAe35471986b65b8a8A15594Ab5BE40` |

On testnets its owner, Flow signer and treasury are `0x75464f762bc50d0A0B127ab5a085504BF102Bb88`.
The address depends on them and on the network's USDC; deploy with:

```sh
cd contracts
export GATOPAGO_PAYMENTS_OWNER=0x… GATOPAGO_PAYMENTS_SIGNER=0x… GATOPAGO_PAYMENTS_TREASURY=0x…
forge script script/DeployPayments.s.sol --rpc-url <network> --account <foundry keystore> --broadcast \
  --verify --verifier sourcify
```

Afterwards the owner can move the signer to a dedicated key with `setSigner(address)`: the router's
address does not change, and Flow's `PAYMENT_SIGNER_PRIVATE_KEY` becomes that key instead of the
owner's.

### Deployment variables

| Name                         | Script           | What it is                                                                          |
| ---------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `GATOPAGO_SPONSOR_SIGNER`    | `DeployWallet`   | Address whose signatures the paymaster accepts; Wallet Core's `SPONSOR_PRIVATE_KEY` |
| `GATOPAGO_PAYMASTER_OWNER`   | `DeployWallet`   | Paymaster owner: manages and withdraws its deposit (cold key or multisig)           |
| `GATOPAGO_PAYMASTER_DEPOSIT` | `DeployWallet`   | Wei deposited in the EntryPoint for the paymaster; optional                         |
| `GATOPAGO_PAYMENTS_OWNER`    | `DeployPayments` | Router owner: pauses it, sets its signer and treasury                               |
| `GATOPAGO_PAYMENTS_SIGNER`   | `DeployPayments` | Initial signer of payment authorizations (Flow's key)                               |
| `GATOPAGO_PAYMENTS_TREASURY` | `DeployPayments` | Receives the platform fee                                                           |

The keystore (`--account`) signs the deployment; private keys never go in environment variables.

## Commands

```sh
pnpm install
pnpm contracts:install   # forge-std, OpenZeppelin 5.7.0 and EntryPoint v0.9.0, pinned
pnpm contracts:build
pnpm contracts:test
pnpm build               # builds packages/* into dist/ and type-checks the published declarations
pnpm test                # end-to-end test: needs anvil and internet access (forks)
pnpm pack                # writes the SDK tarballs to output/
node scripts/storage-layout.mjs   # account upgrade compatibility (also in CI)
```

CI also checks formatting, the wallet gas snapshot (`contracts/.gas-snapshot`) and runs Slither.
Slither cannot analyze three OpenZeppelin functions the account inherits
(`MultiSignerERC7913._validateSignatures`, `ERC7821.execute`, `supportsExecutionMode`); CI fails if
any other function joins them. `scripts/storage-layout.mjs` compares the account's storage down to
struct members and its ERC-7201 slots, and fails without a recorded layout.

## SDK for the other repositories (vendor)

Consumers install the SDK from a tarball in their `vendor/` folder:

1. Bump the version in `packages/*/package.json` and run `pnpm pack`.
2. Copy `output/gatopago-*-<version>.tgz` into the consumer's `vendor/`.
3. In the consumer: `pnpm add ./vendor/gatopago-shared-<version>.tgz`.
