# GatoPago Contracts

Account V3 y contratos GatoPago de pagos. Node 24, pnpm 11.23.0, Foundry 1.7.1
y solc 0.8.34. No requiere Web, Wallet Core, Flow ni el workspace raíz.

```sh
pnpm install --frozen-lockfile
pnpm install:solidity
pnpm verify
```

Las dependencias Solidity están fijadas a commits completos y verificadas por
contenido. `install:solidity` aplica LF sólo al proceso de Git hijo, sin modificar
la configuración global. Los vectores propios están en `test/fixtures`.

`verify` compila, ejecuta Foundry, comprueba tamaños y lint. Los forks necesitan
RPC configurado; un fork omitido no es prueba de red. Ningún comando anterior
despliega contratos o utiliza fondos remotos.

`release-package` contiene snapshots mínimos de ABI/bytecode para consumidores
de pruebas. No sustituye un deployment manifest ni prueba despliegues. Una
nueva versión se entrega explícitamente; los consumidores no leen `out/`.

El remapping de EntryPoint ahora es local `node_modules/`, no `../node_modules`.
Esto puede cambiar metadata/bytecode y por tanto futuras predicciones CREATE2.
Los archivos de `deployments/421614/account-v3` del 26 de septiembre conservan
sus fuentes y artefactos archivados sin cambios: usar esos archivos para
reproducir aquel despliegue, no atribuirle esta compilación nueva. No se realizó
redeploy, upgrade ni cambio de policy como parte de la separación de repos.
