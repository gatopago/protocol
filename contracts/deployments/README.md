# GatoPago deployment manifests

The current V3 account deployment is [Arbitrum Sepolia, 2026-09-26](421614/account-v3/README.md).
Its evidence includes the two libraries, implementation, factory and WebAuthn
verifier. It is not yet an admitted Wallet Core/Web creation profile.

The existing Parmelia/V2 manifests are historical, not V3 admission. New V3
source/CREATE2 salts must never be paired with those addresses. See the
[V3 release runbook](../../docs/operations/v3-contract-regularization-2026-09-21.md).

Only successful, source-checked deployments belong here. A dry-run is evidence
for preflight and deterministic address prediction, but it is not a deployment
manifest.

`<chain-id>/account-stack-v2.json` records the account implementation,
factory, WebAuthn verifier and paymaster as one atomic wallet-rail release. It
also freezes the paymaster deposit, stake, limits, roles, transaction hashes,
runtime bytecode hashes and public source-verification URLs.

`testnet-smoke-evidence.json` freezes the post-deployment closure proof: source
and destination receipts, consumed intent/attempt/op identifiers, completed
CCTP v2 messages, used destination nonces and zero router balances. It contains
public testnet metadata only; attestations and full CCTP message bytes are not
duplicated in the repository.

After broadcasting and verifying source, generate one manifest per router:

Use the immutable timestamped `run-<timestamp>.json` path in the final manifest;
`run-latest.json` is only a convenient staging pointer and can be overwritten by
the next script on the same chain.

```powershell
node scripts/write-contract-deployment-manifest.mjs `
  --broadcast contracts/broadcast/Deploy.s.sol/421614/run-<timestamp>.json `
  --rpc-url $env:ARBITRUM_SEPOLIA_RPC_URL `
  --output contracts/deployments/421614/payment-router-v2.json `
  --contract ParmeliaPaymentRouterV2 `
  --chain-id 421614 `
  --owner 0x... `
  --treasury 0x... `
  --authorization-signer 0x... `
  --pause-guardian 0x... `
  --verification-url https://repo.sourcify.dev/...
```

For `ParmeliaCrosschainRouter`, pass `--role-profile crosschain` and omit
`--authorization-signer`/`--pause-guardian`; those manifest fields are `null`
because that outbound router has no authorization signer or pause guardian.

The generator fails closed if the live transaction/receipt, chain ID, latest
runtime bytecode or any on-chain role does not match. When the RPC retains
historical state it additionally proves that the runtime bytecode at the
deployment block equals `latest`; `runtimeBytecodeChecks.deploymentBlock`
records whether that stronger check was available. It also refuses an
incomplete `Ownable2Step` handoff. `source.commit`, `source.matchesCurrentHead` and
`source.worktreeDirty` preserve the exact provenance boundary; if the build was
dirty, the public verification URL remains the source-of-truth for the exact
source. Manifests contain public deployment metadata only; never add RPC URLs,
keystore paths, credentials or private keys.
