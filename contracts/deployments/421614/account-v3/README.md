# Account V3 — Arbitrum Sepolia

Desplegado el **26 de septiembre de 2026** desde
`0x75464f762bc50d0A0B127ab5a085504BF102Bb88`, con Foundry 1.7.1 y Solidity
0.8.34, via-IR, Cancun y optimizer=200. Red: `421614`.

| Componente | Dirección |
|---|---|
| Security | [`0x5d35d52853f1649EB05BeeDFcE4AA2b33CF37539`](https://sepolia.arbiscan.io/address/0x5d35d52853f1649EB05BeeDFcE4AA2b33CF37539) |
| Upgrade | [`0xcFA137d56DD8EaA3FD115BFaDe009bd897092F10`](https://sepolia.arbiscan.io/address/0xcFA137d56DD8EaA3FD115BFaDe009bd897092F10) |
| Implementación | [`0xFe909a09561632a0f9b1A5a00090A658820e4122`](https://sepolia.arbiscan.io/address/0xFe909a09561632a0f9b1A5a00090A658820e4122) |
| Factory | [`0x61C74d8F0834791db732Fba9AC022224bF3bBB5f`](https://sepolia.arbiscan.io/address/0x61C74d8F0834791db732Fba9AC022224bF3bBB5f) |
| Verificador WebAuthn | [`0x33Def7fd931a7Df910fE7DEF70327cB15712C71A`](https://sepolia.arbiscan.io/address/0x33Def7fd931a7Df910fE7DEF70327cB15712C71A) |

EntryPoint v0.9: `0x433709009B8330FDa32311DF1C2AFA402eD8D009`.
Los cinco componentes se desplegaron mediante el CREATE2 deployer canónico
`0x4e59b44847b379578588920cA78FbF26c0B4956C`. La wallet firmó las transacciones;
no es el deployer que debe usarse en la fórmula CREATE2.

## Verificación

Las cinco transacciones tienen recibos exitosos. Se contrastaron calldata y
direcciones CREATE2 con la simulación y los artefactos compilados. El código
runtime completo, incluidas las variables inmutables, coincide con los
artefactos. También se comprobaron 17 getters de composición e identidad de la
factory y la implementación. Sourcify verificó los cinco contratos con
coincidencia exacta; sus respuestas y URLs están en [deployment.json](deployment.json).

Coste total de las cinco transacciones: **0,000420910571207120 ETH de prueba**.
No hubo cambios en Solidity para realizar este despliegue. Las 31 fuentes y
archivos de configuración comparados coincidían con la copia que pasó la suite
contractual de 395 pruebas; se volvió a comprobar la integridad de las dependencias.

## Evidencia y alcance

[deployment.json](deployment.json) registra direcciones, code hashes, recibos,
settings de compilación, verificación pública y checkpoints observados. Los
archivos `libraries-broadcast-transactions.json` y `core-broadcast-transactions.json`
conservan las transacciones públicas de cada fase. `deployment-source.tar.gz`
contiene las fuentes propias y configuración utilizadas; `build-artifacts.tar.gz`
conserva los seis artefactos exactos, incluido el proxy. Sus hashes SHA-256 están
en el manifiesto.

La fuente procede del árbol **con cambios sin commit**, cuya base es `2257fa6`.
Los hashes y archivos anteriores identifican el contenido desplegado; ese commit
por sí solo no lo reproduce. Los metadatos de compilación incluyen los hashes de
las dependencias y los enlaces de cada fase.

Este registro es evidencia de despliegue. El perfil de creación compartido por
Wallet Core/Web está en `shared/v3/arbitrum-sepolia-creation.json`; se deriva de
estos artefactos mediante `scripts/v3-deployment-profile.mjs`. La inspección
del backend con Offchain Labs y Tenderly ya comprobó la composición en un bloque
finalizado. Faltan los recursos de staging y el bundler para activar el entorno
y realizar el smoke con passkey y transferencia. El checkpoint de este registro
es la observación inicial del despliegue, anterior a esa inspección.

Este despliegue no incluye paymaster ni routers de pagos. No se desplegaron
cuentas de usuarios, Workers ni frontend.
