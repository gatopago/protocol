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

`pnpm distribute` construye, empaqueta y copia la release verificada a los destinos definidos en `scripts/distribute.mjs`. Se revisan destinos y dependencias antes de ejecutarlo; copiar un archive no actualiza por sí solo las dependencias ni los lockfiles de los consumidores. El script observado incluye Web, WalletCore y Flow; Dashboard no tiene una dependencia directa del SDK en la revisión de alcance y no se añade artificialmente.

## Actualización de consumidores

1. Revisar diffs, versión instalada, compatibilidad y manifest del archive nuevo.
2. Distribuir mediante el script del productor, conservando los archivos aún referenciados. Si hay una colisión de bytes para una versión existente, rechazar la distribución.
3. Actualizar únicamente las dependencias internas afectadas a `file:vendor/<nombre>-<versión>.tgz` y generar el lockfile con el gestor del consumidor. No editar integridades a mano.
4. Comprobar instalación frozen en un directorio aislado que incluya los archives y el lockfile, y ejecutar los checks y el build existentes del consumidor. WalletCore, Web y Flow mantienen sus dominios y servicios independientes.
5. Registrar resultados por consumidor antes de continuar con el siguiente. Dashboard sólo se incluye si realmente consume una biblioteca de esta release.
6. Retirar snapshots sin referencias activas después de verificar la instalación nueva; conservar los necesarios para reproducibilidad y rollback.

La CI del productor debe ejecutar comandos existentes de instalación frozen, build, pruebas, pack y consumo aislado. En esta revisión, el YAML aún referencia `pnpm run pack` y `pnpm check:consumer`, que no están en el package.json actual: falta reconciliar esas referencias. Este documento no acredita una ejecución nueva de CI ni de los scripts.

## Recuperación

Volver al archive anterior conocido, sus dependencias exactas y su lockfile. Conservar los bytes originales, manifests y evidencia de compatibilidad. El rollback del SDK no modifica contratos, cuentas, permisos ni datos remotos.
