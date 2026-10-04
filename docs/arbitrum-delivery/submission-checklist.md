# Preparación de candidatura Arbitrum

Actualización local: 2026-10-03 (capturas UTC del 4 de octubre). Estado: infraestructura pública disponible, SDK interno 3.2.3 validado localmente; candidatura y demo pública pendientes. Este checklist no es evidencia de envío a HackQuest.

Alcance corregido el 3 de octubre por Daniel: el SDK es interno y nunca se publicará en un registro. La aceptación de R2 utiliza archives privados verificados y consumidores independientes.

- [x] Identificar Arbitrum Sepolia, `chainId=421614`, y distinguir testnet de mainnet.
- [x] Mantener direcciones, código, mercado y despliegue fijados; registrar comprobaciones RPC y fork.
- [x] Implementar localmente depósito, retiro y retiro seguido de pago con una autorización SPEND por operación.
- [x] Distribuir SDK interno 3.2.3 automáticamente y verificar los tipos, exports y compilación de WalletCore, Web y Flow en carpetas nuevas; [evidencia](internal-sdk-3.2.3.json).
- [x] Preparar [compatibility-matrix.md](compatibility-matrix.md) y el estado de pruebas, sin convertir validación local en aceptación pública.
- [x] Registrar el fallo de creación con 496.000 y la simulación bilateral aprobada con 750.000; conservar la captura anterior.
- [x] Registrar 17 pruebas de composición, incluidos rechazo por pausa, posición y liquidez insuficiente en el fork fijado, sin efectos financieros parciales.
- [x] Leer la versión remota y los recursos exactos: Worker 51, D1 con 0001–0003, ocho tablas monetarias ausentes, colas de jobs/DLQ existentes; [evidencia](remote-preflight-readonly.json).
- [x] Actualizar la lectura remota: Worker versión 60, patrocinio configurado, siete contratos con código coincidente en dos RPC y D1 con migraciones 0001–0005 y los 36 objetos monetarios esperados. Sólo metadata y lectura de cadena; [evidencia actual](public-readiness-current.json).
- [x] Integrar y verificar el guard de esquema anterior al upload: ocho pruebas Node, ocho casos dirigidos y dry-run; rechazo real por 0004/36 objetos ausentes, sin escrituras. [Evidencia](deployment-schema-guard.json).
- [x] Corregir y probar el rechazo de challenges válidos por desfase de reloj: 90 pruebas dirigidas, parser contra API real y Web con 967 casos. [Pruebas](auth-clock-skew.json) y [publicación](r1-web-deployed.json); login real pendiente.
- [ ] Cerrar T01: passkey real, sesión, activación, recepción, transferencia y comprobante conciliado de una cuenta de prueba.
- [x] Identificar API/Web publicadas, fuentes, commits de copias Git limpias y guards; [Core](r1-core-deployed.json) y [Web](r1-web-deployed.json). Los commits son locales y no acreditan publicación de código en GitHub.
- [x] Aplicar y comprobar 0004 en el D1 existente; 36 objetos exactos, ledger 0001–0004 y esquema aditivo. El error inicial del parser remoto se corrigió conservando las restricciones; [evidencia](r1-core-deployed.json).
- [ ] Admitir el mercado y el gas exterior Nitro en esa release; comprobar operador, funding y límites exactos antes de cada envío.
- [ ] Habilitar únicamente las recetas admitidas y ejecutar D01–D06 en orden; guardar los resultados reales en [demo-transactions.json](demo-transactions.json).
- [ ] Registrar bloques, finalidad, eventos propios, saldos, posición, allowance y gas; distinguir un revert del éxito financiero.
- [ ] Comprobar recuperación tras cerrar/reabrir sin otro envío y la transferencia anterior D06.
- [ ] Grabar la demo y comprobar sus enlaces y el acceso del juez a la aplicación y al código solicitado por el formulario.
- [ ] Identificar el trabajo previo y el delta de la buildathon mediante fuentes y commits reales; los HEAD iniciales no describen el árbol modificado.
- [ ] Completar los campos y materiales requeridos por el dashboard autenticado de participación y registrar el envío efectivo.
- [ ] Confirmar la zona horaria del cierre en el dashboard; la página pública muestra 4 de octubre de 2026, 15:59, sin zona explícita en el texto leído.
- [x] Verificar R2 local: distribución automatizada, versiones e integridad, comandos de CI existentes y compilación independiente de los tres consumidores con lockfiles congelados. [Evidencia](internal-sdk-3.2.3.json) y [runbook](sdk-internal-distribution.md); ejecución remota de CI no observada.
- [x] Preparar los seis campos técnicos del formulario y comprobar sus longitudes; [valores listos para revisión](submission-draft.json).
- [ ] Revisar el proyecto elegido en HackQuest: el formulario observado selecciona «Parmelia copy» y sólo ofrece «Parmelia» y «Parmelia copy». No se creó un proyecto ni se escribió sobre esos proyectos.

La [página oficial de la buildathon en HackQuest](https://www.hackquest.io/es/hackathons/Arbitrum-Open-House-Singapore-Online-Buildathon), consultada el 2 de octubre de 2026, admite proyectos desplegados en una cadena Arbitrum e incluye Arbitrum Sepolia entre sus ejemplos. Sus criterios incluyen calidad contractual, producto, innovación y problema resuelto. La publicación de esta lista no acredita haber presentado la candidatura ni satisfacer cada campo del formulario autenticado.

Descripción que debe ajustarse a la demo efectivamente cerrada: la cuenta propia compone una interacción Aave y un pago exacto mediante una autorización verificable. Cada operación R1 pide consentimiento nuevo. No anunciar pagos periódicos automáticos, R3, mainnet, auditoría independiente ni disponibilidad pública de las recetas mientras no estén demostrados.

## Campos preparados para revisión

El [borrador del formulario](submission-draft.json) contiene direcciones verificadas, la URL pública, tecnologías y una descripción del trabajo realizado que distingue validación local de demo pública. Todos los campos de texto preparados caben en 300 caracteres. La tecnología de patrocinador identificada es OpenZeppelin; las categorías de premios quedan para revisar con sus criterios.

| Campo | Caracteres |
| --- | ---: |
| Contrato principal: AccountFactoryV3 | 42 |
| URL de la interfaz | 20 |
| Implementación, verifier, seguridad, upgrades y paymaster | 265 |
| Factory y Pool Aave | 117 |
| USDC y aUSDC de Arbitrum Sepolia | 117 |
| Trabajo añadido durante la buildathon | 271 |

El contrato principal del borrador es la factory desplegada, no una dirección personal para recibir fondos. La prueba con una cuenta real, las transacciones de la demo y el envío del formulario permanecen pendientes.
