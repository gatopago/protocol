# Deployments

Public records of deployed contracts, by network. They never contain RPC URLs, keystores or keys.

- `wallet.json`: the wallet (`script/DeployWallet.s.sol`) on Arbitrum Sepolia, Avalanche Fuji and
  Monad testnet: same addresses everywhere, with each network's transactions and blocks.
- `<chain-id>/*-router*.json`: Universal Checkout payment routers (Flow).
- `testnet-smoke-evidence.json`: end-to-end payment proof of the routers on testnet.
