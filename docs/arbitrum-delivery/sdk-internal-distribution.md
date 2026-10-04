# Distribución interna del SDK R2

Decisión de Daniel, 3 de octubre de 2026: el SDK es interno y nunca se publicará en un registro. Protocol produce las bibliotecas que consumen los repositorios de GatoPago. `@gatopago` organiza sus nombres; no requiere ownership de un scope npm para instalar archives locales. Los productores mantienen `private: true`.

## Objetivo y aceptación

O4/T10/T11/T12 requieren un productor identificable, paquetes compilados, tipos y exports explícitos, versiones exactas, SHA-256 y lockfiles con integridad. La distribución normal se automatiza y cada consumidor debe instalarse y compilar sin el checkout fuente de Protocol ni node_modules heredados. Los archives `file:vendor/*.tgz` son una distribución interna admitida.

La evidencia local, el consumo aislado y la ejecución remota de CI se registran por separado. No se declara una nueva versión verificada a partir de pruebas de un snapshot anterior. Publicación npm, bootstrap de paquetes, trusted publishers, autenticación npm y licencia pública quedan fuera del alcance.

## Flujo del productor

Desde `protocol`, consultar primero el package.json y los scripts del checkout revisado. Comandos presentes en la revisión de alcance:

```sh
pnpm build
pnpm test
node scripts/pack-sdk.mjs
node scripts/check-sdk-consumer.mjs
```

El pack debe validar los tres archives antes de promoverlos. El manifest registra versión, archivos, hashes, commit, estado de cambios locales y fuentes. Una versión existente conserva sus bytes; un cambio de contenido exige una versión nueva. El checker debe consumir esos archives en un directorio nuevo con lockfile congelado, sin aliases al productor, y comprobar ESM, require y tipos NodeNext estrictos.

`pnpm distribute` construye, empaqueta, comprueba colisiones y actualiza WalletCore, Web y Flow en ese orden. Actualiza las dependencias SDK que ya existen y sus overrides locales, genera el lockfile mediante pnpm, instala con `--frozen-lockfile --ignore-scripts` y conserva la procedencia en `vendor/sdk-manifest.json`. Después archiva en `vendor/archive/<versión>/` los snapshots SDK que ya no aparecen en package.json, overrides o lockfile, verificando que conservan sus bytes. Mantiene en la ruta activa la release actual y los paquetes aún referenciados. Dashboard no tiene una dependencia directa del SDK y no se añade artificialmente.

Para actualizar un único repositorio, usar `pnpm distribute --consumer gatopago-wallet-core`, `pnpm distribute --consumer gatopago` o `pnpm distribute --consumer gatopago-flow`. No hace falta editar versiones, integridades ni copiar paquetes a mano. Después se ejecutan los checks y el build del consumidor afectado.

## Actualización de consumidores

1. Revisar diffs, versión instalada, compatibilidad y manifest del archive nuevo.
2. Distribuir mediante el script del productor, conservando los archivos aún referenciados. Si hay una colisión de bytes para una versión existente, rechazar la distribución.
3. Actualizar únicamente las dependencias internas afectadas a `file:vendor/<nombre>-<versión>.tgz` y generar el lockfile con el gestor del consumidor. No editar integridades a mano.
4. Comprobar instalación frozen en un directorio aislado que incluya los archives y el lockfile, y ejecutar los checks y el build existentes del consumidor. WalletCore, Web y Flow mantienen sus dominios y servicios independientes.
5. Registrar resultados por consumidor antes de continuar con el siguiente. Dashboard sólo se incluye si realmente consume una biblioteca de esta release.
6. Retirar snapshots sin referencias activas después de verificar la instalación nueva; conservar los necesarios para reproducibilidad y rollback.

La CI del productor ejecuta instalación frozen, build, pruebas, pack y consumo aislado. `pnpm run pack` y `pnpm check:consumer` ya están definidos en el package.json actual y coinciden con el YAML. La configuración de CI no acredita por sí sola una ejecución remota.

## Recuperación

Volver al archive anterior conocido, sus dependencias exactas y su lockfile. Los snapshots retirados están en `vendor/archive/<versión>/`; al restaurar el package.json y su lockfile anterior, copiar de vuelta esos mismos archivos a `vendor/` antes de la instalación frozen. Conservar los bytes originales, manifests y evidencia de compatibilidad. El rollback del SDK no modifica contratos, cuentas, permisos ni datos remotos.
