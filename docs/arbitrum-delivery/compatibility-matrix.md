# Compatibilidad de la entrega Arbitrum

Fecha: 2026-10-02. Esta matriz incluye el árbol local y las releases públicas registradas de API/Web. El recorrido autenticado y financiero sigue pendiente; el estado de cierre está en [STATUS.md](STATUS.md).

| Componente o frontera | Versión y comportamiento | Evidencia | Límite pendiente |
| --- | --- | --- | --- |
| Web y WalletCore | `shared`, `environment` y `test-fixtures` 3.2.1 desde archives locales; versiones exactas en manifests y lockfiles | Guards vendor y verificaciones de ambos consumidores; [sdk-release-3.2.1.json](sdk-release-3.2.1.json) | Publicación e instalación desde registry |
| SDK aislado | ESM compilado, declaraciones NodeNext y require de Node 24; 67 exports ESM y 61 require | [sdk-consumer-local.json](sdk-consumer-local.json) | Los archives no constituyen publicación npm |
| Productor aislado | Instalación frozen sin dist/node_modules heredados, 32 pruebas, 139 archivos empaquetados idénticos | [sdk-producer-local.json](sdk-producer-local.json) | Snapshot de fuentes locales; no commit publicado ni CI remota demostrados |
| Publisher SDK | Workflow manual; Node 24.19.0, npm 12.0.2, pnpm 11.23.0; ref exacto, OIDC, acceso público/restringido e integridad | [sdk-publication-local.json](sdk-publication-local.json): 18 pruebas locales y listas npm de 139 archivos | Política deshabilitada; falta configurar npm, ejecutar CI, publicar e instalar desde registry |
| Flow | `shared` y `environment` 3.1.1; backend comercial separado | Manifest actual leído | Sin nuevo smoke comercial público en esta entrega |
| Dashboard | Consumidor comercial separado; sin nuevas recetas money | Manifest actual leído | Sin nuevo smoke comercial público en esta entrega |
| Protocolo HTTP | `wallet-client-v3.1`, `wallet-core-v3.1`, entorno `production`; generación/manifest explícitos | Parsers y guards; [public-access-preflight.json](public-access-preflight.json) | Challenge de acceso HTTP 200 no demuestra sesión ni operación financiera |
| Dominio money | Schema 1; tres recetas cerradas y revisiones independientes en Web/API | SDK, pruebas Web/Worker/D1 y [money-composition.json](money-composition.json) | Flags cerradas; ejecución pública pendiente |
| Contratos | Account V3 generación 3; EntryPoint 0.9; CALL/SPEND existente | Vectores Solidity/TypeScript y fork fijado | Sin upgrade contractual de producción ni reglas persistentes R3 |
| Restricciones del mercado | Preparación/current-state rechazan pausa, deuda y falta de fondos; el fork verifica pausa y falta de posición/liquidez sin efectos parciales | Tests Worker y [money-risk-fork.json](money-risk-fork.json), 17 casos de composición | Fallos de pausa/liquidez inyectados localmente; sin prueba pública de usuario |
| Recursos publicados | Worker 52 al 100 %, D1 con 0001–0004/36 objetos verificados y colas existentes; Web READY en `gatopago.com` | [Core/D1](r1-core-deployed.json) y [Web](r1-web-deployed.json), commits limpios aislados y builds identificados | Flags money cerradas; sesión, demo financiera y registro npm sin demostrar |
| Creación | Techo local de verificación 750.000; transporte self con límite exterior 2.000.000 | [passkey-runtime-readonly.json](passkey-runtime-readonly.json) y pruebas de configuración/restauración | `eth_call` con balances sintéticos; faltan passkey física, fondos reales, broadcast y receipt |
| Revisión de creación anterior | Sus límites guardados y compromiso firmado se restauran sin recalcularlos por el nuevo catálogo | Prueba workerd `restores and authorizes the exact earlier review after the runtime creation ceiling changes` | La simulación de entrega sigue siendo obligatoria; una revisión antigua insuficiente no se eleva automáticamente |
| Transferencias anteriores | API y SDK previos conservados; lock compartido con money durante migration | Pruebas de migración, concurrencia y rutas existentes | Demo D06 con la misma release pública que money |
| Historial money | Lecturas bajo ownership actual; confirm/deliver mantienen autorización vigente | Pruebas workerd de renovación/revocación de sesión | Login real pendiente |
| Recuperación de envío | Mismos bytes/nonce registrados; timeout conserva reserva | Pruebas de transporte, jobs y conciliación | No sustituye prueba pública de disponibilidad del operador |

El techo de 750.000 pertenece al transporte self configurado. No afirma admisión de un bundler con un techo de verificación distinto. La [captura anterior](creation-budget-496k-readonly.json) conserva el rechazo de 496.000 y la aceptación de 750.000 en los dos RPC. El cambio de configuración no modifica operaciones ya preparadas, el gas de transferencias ni las recetas Aave.

Las tres capacidades money están deshabilitadas hasta cerrar los gates de release. Leer un manifest, instalar un paquete o observar un contrato no acredita el recorrido completo del usuario.
