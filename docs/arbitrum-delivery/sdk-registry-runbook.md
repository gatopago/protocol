# Publicación del SDK R2

Estado actual: preparación local. No se ha ejecutado este workflow en GitHub ni
se ha publicado un paquete. `config/sdk-publication.json` conserva `enabled:
false`, ningún paquete seleccionado y licencia/visibilidad sin decidir. Los
archives privados 3.2.0/3.2.1 y los consumidores actuales siguen vigentes.

El productor es `gatopago/protocol`; el registry previsto es npm y el workflow es
[sdk-release.yml](../../.github/workflows/sdk-release.yml). La validación de PR
no tiene permiso OIDC de publicación. El workflow de release sólo acepta
`workflow_dispatch`, un commit completo y una versión exacta; `publish` empieza
en `false`. El ref del workflow, `GITHUB_SHA`, `GITHUB_WORKFLOW_SHA` y el checkout
deben corresponder al mismo commit. No usa un environment con un nuevo paso de
aprobación ni publica automáticamente por push o tag.

Para completar los datos de distribución:

1. Determinar ownership/permisos de `@gatopago`, licencia y acceso de cada
   paquete. Seleccionar `shared` y `environment` con decisiones explícitas;
   `test-fixtures` se evalúa por separado. No incluir marca ni artefactos de
   contratos en este publisher.
2. En los paquetes seleccionados, fijar una nueva versión alineada, `private:
   false`, la licencia elegida, `repository.url` igual a
   `git+https://github.com/gatopago/protocol.git` y `repository.directory` igual a
   su carpeta `packages/<nombre>`. Conservar los archives anteriores. No cambiar
   metadata de un snapshot existente y presentarlo como el mismo archive.
3. Fijar `publishConfig.registry` a `https://registry.npmjs.org/`, su `access`
   decidido (`public` o `restricted`) y `provenance`: `true` únicamente cuando
   repositorio y paquete sean públicos. Completar los mismos valores en la
   política; habilitarla sólo cuando el publisher y los paquetes estén listos.
   Si se añaden README/LICENSE al paquete, actualizar expresamente los allowlists
   de pack y comprobación de archivos, incluyendo esos archivos en la nueva
   evidencia; no omitir el texto de licencia para pasar un guard.
4. Completar el bootstrap inicial del paquete en npm y configurar su trusted
   publisher con propietario/repositorio `gatopago/protocol` y filename exacto
   `sdk-release.yml`. La política no crea ese vínculo ni acredita ownership.
   El publisher exige que el nombre ya exista con el acceso previsto: no interpreta
   un 404 anónimo como permiso para crear o cambiar visibilidad.
5. Para paquetes restringidos, configurar `NPM_READ_TOKEN` con lectura granular
   de los paquetes necesarios. Se usa sólo para comprobar existencia/integridad
   privadas. El proceso `npm publish` recibe un entorno sin credenciales npm
   permanentes y utiliza los handles OIDC del runner. No versionar un `.npmrc`
   con credenciales ni pegar tokens en chat o argumentos.

Toolchain del workflow: Node 24.19.0, npm 12.0.2, pnpm 11.23.0, runner GitHub
`ubuntu-24.04`; actions fijadas por commit. La instalación usa el lockfile
congelado y las operaciones npm deshabilitan scripts de ciclo de vida. El build
y los scripts de verificación propios sí se ejecutan como parte de la validación.

La validación reconstruye el SDK, ejecuta sus pruebas, empaqueta, comprueba bytes
y procedencia, e instala en el consumidor aislado. `npm pack --dry-run` se ejecuta
desde cada productor: npm no lee `pnpm-workspace.yaml`. Sus listas deben coincidir
con los archivos de los archives verificados. El job de publicación reconstruye
desde el mismo commit; exige fuentes limpias y comprueba SHA-256 de cada archive.

Antes del primer publish, comprueba todos los paquetes en el registry. Una
versión ausente sólo se publica bajo acceso previamente establecido. Si ya
existe, exige la misma integridad SHA-512 y la registra como
`already_present_verified`; nunca sobrescribe ni vuelve a publicar otra carga
bajo esa versión. Así puede continuar una release parcial con los mismos bytes.
Después de publicar vuelve a comprobar la integridad registrada.

`output/sdk-releases/registry-release-<version>.json` registra commit, hash del
árbol de fuentes, política, toolchain, generación contractual/schema, archivos,
integridad y estado por paquete. Se conserva también si falla el preflight o la
publicación. El workflow sube los resultados como artifact; un artifact de
validación no acredita publicación ni instalación desde registry.

Comprobaciones locales disponibles:

```sh
node --test test/sdk-publication.test.mjs
node scripts/sdk-publication.mjs --schema-only
node scripts/sdk-publication.mjs --pack-check --version 3.2.1
node scripts/sdk-publication.mjs --check --version 3.2.1
```

El último comando informa `publication_dependencies_pending` mientras falten
los datos; ese resultado esperado no significa `T11 DONE`. T11 todavía necesita
ejecución real autorizada, publicación comprobada e instalación limpia desde
registry. T12 conserva su orden de migración: WalletCore, Web, Dashboard y Flow,
con verificación y lockfile exacto de cada consumidor antes del siguiente.

La [documentación de trusted publishing de npm](https://docs.npmjs.com/trusted-publishers/)
explica la configuración inicial, Node/npm mínimos y la limitación de provenance
para repositorios/paquetes privados. La
[referencia npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
define versiones inmutables, integridad SHA-512 y efectos de `--access`; el workflow
comprueba el acceso existente para conservar la visibilidad decidida.
