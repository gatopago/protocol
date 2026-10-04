# GatoPago Protocol

The onchain layer of GatoPago: **passkey-controlled smart accounts and USDC
payment rails**. Account V3 holds a user's assets at a personal contract address
and checks signed instructions before executing transactions or changing security.
It is not the frontend, the backend, or a shared wallet holding every user's funds.

## Compiled SDK producer

`packages/shared`, `packages/environment` and `packages/test-fixtures` produce
compiled ESM and declarations for internal use across GatoPago repositories.
Packages remain `private: true` and will not be published to a registry.
Consumer package.json files and lockfiles identify their installed snapshots.

Run `pnpm build` and `pnpm test` from this repository root.
For packaging alone, use `node scripts/pack-sdk.mjs`.
The pack script validates all three archives in a temporary directory before
promoting them. An existing version retains its original bytes; changed contents
require a new version. `output/sdk-releases/manifest.json` records archive hashes,
the producer commit, working-tree status and individual source hashes.

`pnpm distribute` builds, packs and verifies the release before updating Wallet
Core, Web and Flow. It updates existing SDK dependencies and local overrides,
generates lockfiles with pnpm, installs with `--frozen-lockfile --ignore-scripts`
and saves provenance in each consumer's `vendor/sdk-manifest.json`. Unreferenced
SDK snapshots move to `vendor/archive/<version>/` after the frozen installation;
their bytes remain available for rollback. Use `--consumer gatopago-wallet-core`,
`--consumer gatopago` or `--consumer gatopago-flow` to update one repository.
The root SDK CI is configured for build, tests, pack and the independent consumer
check, using commands defined in package.json. A workflow file is not evidence
of a successful remote run.

`node scripts/check-sdk-consumer.mjs` installs the selected archives in a fresh temporary
consumer using a frozen lockfile. It checks every exported subpath through
native ESM, Node 24 `require` and strict TypeScript NodeNext resolution, with
no aliases to producer sources. Its report is
`output/sdk-releases/consumer-local.json`. This validates internal archives.
Check CI command references against package.json before claiming a remote run.

The [internal distribution runbook](docs/arbitrum-delivery/sdk-internal-distribution.md)
defines versioned archives, automated copying, integrity, consumer upgrades and
rollback. Local `file:vendor/*.tgz` dependencies are supported. SDK publication,
npm scope ownership and publisher authentication are outside the project scope.

The Arbitrum money programs reuse AccountV3 CALL/SPEND. Production contract
source and bytecode are unchanged. Their local, fork and public delivery states
are tracked in [the implementation status](docs/arbitrum-delivery/STATUS.md).

## Account V3 deployment

**Network:** Arbitrum Sepolia · **Chain ID:** `421614` · **Recorded deployment:** September 26, 2026.

The [deployment manifest](contracts/deployments/421614/account-v3/deployment.json)
records successful receipts, runtime hashes and exact-match Sourcify verification
for the five GatoPago components below. EntryPoint is an external dependency.
These are recorded deployment facts, not a new live inspection or an audit certification.

| Contract | Address | Purpose |
| --- | --- | --- |
| [AccountFactoryV3](contracts/src/v3/AccountFactoryV3.sol) | [0x61C74d8F0834791db732Fba9AC022224bF3bBB5f](https://sepolia.arbiscan.io/address/0x61C74d8F0834791db732Fba9AC022224bF3bBB5f) | Predicts and creates each user's account with CREATE2 and authenticated initialization. |
| [AccountV3](contracts/src/v3/AccountV3.sol) | [0xFe909a09561632a0f9b1A5a00090A658820e4122](https://sepolia.arbiscan.io/address/0xFe909a09561632a0f9b1A5a00090A658820e4122) | Shared initial implementation: execution, signature validation and controlled UUPS upgrades. |
| [AccountV3WebAuthnVerifier](contracts/src/v3/AccountV3WebAuthnVerifier.sol) | [0x33Def7fd931a7Df910fE7DEF70327cB15712C71A](https://sepolia.arbiscan.io/address/0x33Def7fd931a7Df910fE7DEF70327cB15712C71A) | Checks passkey assertions against the public key, RP ID, origin, challenge and user verification. |
| [AccountV3Security](contracts/src/v3/AccountV3Security.sol) | [0x5d35d52853f1649EB05BeeDFcE4AA2b33CF37539](https://sepolia.arbiscan.io/address/0x5d35d52853f1649EB05BeeDFcE4AA2b33CF37539) | Linked library managing signer policies, administrative proposals, nonces and security versions. |
| [AccountV3Upgrade](contracts/src/v3/AccountV3Upgrade.sol) | [0xcFA137d56DD8EaA3FD115BFaDe009bd897092F10](https://sepolia.arbiscan.io/address/0xcFA137d56DD8EaA3FD115BFaDe009bd897092F10) | Linked library checking upgrade consent, timelocks, target compatibility and migration checkpoints. |
| EntryPoint v0.9 | [0x433709009B8330FDa32311DF1C2AFA402eD8D009](https://sepolia.arbiscan.io/address/0x433709009B8330FDa32311DF1C2AFA402eD8D009) | ERC-4337 entry point for account creation, UserOperation validation and execution. |

**These are infrastructure addresses, not deposit addresses.** Each user receives
an [AccountV3Proxy](contracts/src/v3/AccountV3Proxy.sol) with its own address,
balances and storage. The proxy delegates to AccountV3; the fixed linked libraries
operate on the account's storage. The recorded deployment did not create user accounts.

## How an account works

1. **Create:** the user approves the initial signer policy and proves possession
   of its keys. The factory derives the account identity from that initial policy
   commitment and the user's salt, then deploys and initializes the proxy atomically
   through the EntryPoint creation path.
2. **Authorize:** the user signs an execution plan binding the account, network,
   security version, calls, nonce, validity window and execution parameters.
   A login session or a backend request is not spending authority.
3. **Verify:** Account V3 checks the current policy and required signatures.
   WebAuthn verification uses OpenZeppelin's P-256 implementation and additionally
   binds the enrolled RP ID and origin. The protocol also supports authorized
   ECDSA and ERC-1271 signers.
4. **Execute:** EntryPoint runs an authorized UserOperation. Alternatively,
   `executeSigned` relays an exact signed batch directly, with a separate nonce
   and gas paid by the transaction sender; the relay gains no account authority.
5. **Confirm:** backend observation establishes inclusion, finality and the actual
   asset movement. A successful generic contract call alone is not proof that a
   payment settled.

## Security and upgrades

- **SPEND** authorizes asset operations; **ADMIN** changes signers and policies.
  Thresholds belong to the account's policy, not a hardcoded requirement for two passkeys.
- Adding a key requires current authorization and proof of possession of the new key.
  GatoPago, email and support have no special onchain recovery authority. Losing all
  sufficient signing authority cannot be repaired by support.
- Policy changes use `prepare` and `commit`; cancellation requires current ADMIN
  authority. There is no separate RECOVERY role or universal individual-signer veto.
- Upgrades use `proposeUpgrade` and `commitUpgrade`, with a policy delay of at least
  **72 hours**, fresh consent and checks on code, layout and migration. The generic
  `upgradeToAndCall` selector cannot bypass this procedure. ADMIN can permanently
  freeze upgrades. An upgrade preserves the proxy address, not the original implementation.

## Multichain

One identity can have an account instance on each admitted EVM network. CREATE2
produces the same address only when the factory address, proxy creation code and
initial account identity match. Deployment, balances, nonces, signatures and
security changes remain network-specific; neither funds nor removed signers
automatically synchronize across chains. Arbitrum Sepolia is the current consumer
network; historical router deployments on other networks are not Account V3 support.

## Payment contracts

These contracts are separate rails, not part of the five-component Account V3 deployment.

| Source | What it does | How |
| --- | --- | --- |
| [GatoPagoPaymaster](contracts/src/GatoPagoPaymaster.sol) | Sponsors ERC-4337 gas. | Checks a sponsor's authorization and validity window, with a configurable per-operation cost cap. Sponsorship does not replace the user's signature. |
| [GatoPagoPaymentRouter](contracts/src/GatoPagoPaymentRouter.sol) | Accepts same-chain USDC checkout payments. | Checks a signed payment authorization, transfers settlement to the merchant and the disclosed fee to treasury, and prevents reuse of intent/attempt IDs. |
| [GatoPagoCrosschainRouter](contracts/src/GatoPagoCrosschainRouter.sol) | Sends USDC to a supported CCTP destination. | Transfers the capped platform fee, burns the remaining USDC through CCTP v2 and emits an operation ID for tracking. |
| [GatoPagoCctpPaymentRouter](contracts/src/GatoPagoCctpPaymentRouter.sol) | Routes USDC checkout settlement to Arbitrum from another supported chain. | Validates the payer/merchant authorization and fee limits, then initiates CCTP burning. Destination minting and finality still require observation. |

Older deployment records remain under [contracts/deployments](contracts/deployments/).
Their original Parmelia names and artifacts must not be treated as deployments of
the current renamed sources. No mainnet readiness or complete consumer financial
end-to-end validation is claimed here.

## Development

### Consumer deployment includes gas sponsorship

`script/DeployV3.s.sol:DeployV3` deploys the account stack **and a funded
GatoPagoPaymaster**. On Arbitrum Sepolia, the sponsor signer defaults to the
selected deployment wallet. `GATOPAGO_PAYMASTER_SIGNER` is an explicit public
address override, not a request to generate another wallet. The default funding is 0.01 ETH
in the EntryPoint deposit and 0.001 ETH staked with a one-day unstake delay.
These are operator funds; new user accounts do not need ETH for sponsored creation.

Arbitrum Sepolia paymaster:
[`0x702bae7BDda0cB9caA40B97D082CcF8BA17c0cCD`](https://sepolia.arbiscan.io/address/0x702bae7BDda0cB9caA40B97D082CcF8BA17c0cCD).
Its [deployment record](contracts/deployments/421614/paymaster/deployment.json)
contains the confirmed transactions, signer, runtime hash and initial funding.
This adds sponsorship without replacing the September Account V3 deployment.

For the existing September account deployment, add only its paymaster:

```sh
forge script script/Deploy.s.sol:DeployPaymaster \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --account wallet-0x75 --sender 0x75464f762bc50d0A0B127ab5a085504BF102Bb88 \
  --broadcast --verify --verifier sourcify
```

Run from `contracts/`; omit `GATOPAGO_PAYMASTER_SIGNER` to use the deployment
wallet, or set an existing signer address deliberately. Without `--broadcast`, this is
a simulation. The script prints the paymaster address, runtime code hash,
signer, EntryPoint, deposit and cost cap; record the confirmed receipts separately.

For a later full account release, set `GATOPAGO_PAYMASTER_ADDRESS` and
`GATOPAGO_PAYMASTER_CODEHASH` to reuse the existing paymaster. Reuse verifies
its configuration and funding, and sends no deposit, signer-reset or ownership
transactions. Account upgrades do not require replacing the paymaster.

Wallet Core admits the public policy in `config/paymasters.json` and receives
the deployment wallet's existing `PRIVATE_KEY` for relay and sponsorship. Enable it
after checking the deployed code and getters, not from a predicted address.
Deployment and passing local tests are not proof of browser onboarding:
verify a sponsored creation with a zero-ETH account on Arbitrum Sepolia.

Requirements: **Node.js 24**, **pnpm 11.23.0**, **Foundry 1.7.1**.
Compiler: **Solidity 0.8.34**, via-IR, Cancun, optimizer 200.

```sh
cd contracts
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

`build` compiles the contracts; `test` runs the Foundry tests. Neither broadcasts
transactions. Fork tests require RPC configuration;
skipped forks are not network evidence.

Reproduce the September deployment with its [archived sources and build artifacts](contracts/deployments/421614/account-v3/):
recompiling the current tree may change metadata, bytecode and CREATE2 addresses.
`release-package/` contains consumer artifacts, not proof of deployment.
