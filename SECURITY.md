# Security

## Reporting

Report vulnerabilities privately through this repository's GitHub Security Advisories
("Report a vulnerability"). Do not open public issues for security problems.

## Scope

| Component | Code | Audited base |
|---|---|---|
| Account | `contracts/src/wallet/GatoPagoAccount.sol` | OpenZeppelin 5.7 `Account`, `MultiSignerERC7913`, `ERC7913WebAuthnVerifier`, `ERC7821`, `ERC7739`, `UUPSUpgradeable` |
| Factory | `contracts/src/wallet/GatoPagoAccountFactory.sol` | OpenZeppelin `ERC1967Proxy`, `Create2` |
| Paymaster | `contracts/src/wallet/GatoPagoPaymaster.sol` | OpenZeppelin `PaymasterSigner`, `SignerECDSA`, `Ownable` |
| Bundler | `packages/shared/bundler.ts` | — (liveness only, see below) |
| Payment routers (Flow) | `contracts/src/GatoPago*Router.sol` | — |

The contracts target the ERC-4337 EntryPoint v0.9 at `0x433709009B8330FDa32311DF1C2AFA402eD8D009`.
The GatoPago-specific account logic is about 170 lines; it has not had an external audit yet.

## Keys and what they control

| Key | Holder | Can | If compromised |
|---|---|---|---|
| Account owner (passkey) | User | Spend, add/remove owners, upgrade the account | Full control of that account (threshold 1). Other owners can be removed immediately. |
| Sponsor signer | Backend | Authorize the paymaster to pay gas for an operation | Gas for arbitrary operations, up to the paymaster deposit. Rotate with `setSponsorSigner`. |
| Paymaster owner | Cold key / multisig | Rotate the sponsor signer, withdraw deposit and stake | The deposit and stake. |
| Relayer | Bundler (hot) | Submit `handleOps` and pay its gas, refunded by the EntryPoint | The relayer's ETH balance. It cannot sign for accounts or the paymaster. |

GatoPago holds no key that can move user funds, change account owners or upgrade accounts.

## Guarantees (tested)

Covered by `contracts/test/wallet/` (unit, fuzz and invariant tests) and `test/wallet.test.ts`
(viem and the bundler on forks of Arbitrum Sepolia and Avalanche Fuji):

- An account always has at least one owner; the threshold is always 1.
- Owners and the implementation only change through owner approvals (`applyApproval`); the normal
  channel can never call the account itself, directly or through `address(0)`.
- Approvals never move funds, apply once per network, in order, and survive failed attempts
  (the approval sequence only advances when the change succeeds).
- An approval is signed without the chain id, so it applies on every network, including where the
  account is deployed later from its original owners. Payments are always chain-bound.
- Replayed approvals must be sponsored, so they never spend account funds.
- An account address commits to its initial owners and salt; the factory and implementation have the
  same address on every network (CREATE2, metadata-free bytecode).
- The implementation cannot be initialized; a deployed account cannot be re-initialized.
- Only the paymaster owner manages its funds and signer; a rotated signer's sponsorships are rejected.

## Known limitations

- **Threshold 1.** Any single owner passkey controls the account, including removing the others. This
  matches widely used passkey wallets; a delay on owner removal could be added in an upgrade.
- **Lost keys.** If every owner passkey is lost, the account is unrecoverable. Users should add a
  backup passkey on another device.
- **Upgrades are opt-in.** GatoPago cannot upgrade an account; each user approves upgrades. A new
  implementation must keep the storage layout (`node scripts/storage-layout.mjs` in CI) and be deployed
  at the same address on every network before approvals that reference it are replayed there.
- **Bundler.** The bundler is trusted for liveness, not safety: it can delay or drop operations but
  cannot alter them (the account and paymaster signatures cover every field that matters).
- **P256 precompile.** Validation is cheap only where the P256 precompile exists (Arbitrum, Avalanche
  and Monad have it). Elsewhere OpenZeppelin verifies in Solidity at about 350k extra gas; the bundler
  detects this and raises the validation limit.
