# GatoPago Contracts

Foundry project (solc 0.8.34, Foundry 1.7.1). See the [repository README](../README.md) and
[SECURITY.md](../SECURITY.md).

```sh
pnpm contracts:install   # from the repository root: forge-std, OpenZeppelin 5.7.0, EntryPoint v0.9.0
forge build
forge test
```

| Path | Contents |
|---|---|
| `src/wallet/` | Account, factory and paymaster |
| `src/` | Universal Checkout payment routers (used by Flow) |
| `script/DeployWallet.s.sol` | Multichain CREATE2 deployment of the wallet |
| `script/Deploy.s.sol` | Payment router deployment |
| `test/wallet/` | Unit, fuzz and invariant tests of the wallet (`WalletFixture.sol` builds and signs operations) |
| `deployments/` | Records of deployed contracts |
| `storage-layout.json` | Account storage layout that upgrades must keep |
| `.gas-snapshot` | Gas of the wallet tests (`forge snapshot --match-path test/wallet/GatoPagoWallet.t.sol --check`) |
