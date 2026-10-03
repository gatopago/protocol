import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copySdkRelease, promoteSdkRelease, readSdkRelease, sdkPackages, sha256 } from '../scripts/pack-sdk.mjs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gatopago-sdk-test-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  const packages = sdkPackages.map(name => {
    const file = `gatopago-${name}-3.2.1.tgz`;
    const bytes = Buffer.from(`test archive ${name}`);
    writeFileSync(join(source, file), bytes);
    return { name: `@gatopago/${name}`, version: '3.2.1', file, sha256: sha256(bytes), producer: `packages/${name}` };
  });
  const manifest = { schema_version: 1, packages };
  const save = () => writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest));
  save();
  return { root, source, manifest, save };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(basename(root)).toMatch(/^gatopago-sdk-test-/);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('SDK release immutability and distribution', () => {
  it('distributes only the reviewed release, ignoring older archives', () => {
    const { root, source, manifest } = fixture();
    writeFileSync(join(source, 'gatopago-shared-3.2.0.tgz'), 'historical');
    const destination = join(root, 'consumer');
    copySdkRelease(source, [destination]);
    for (const pkg of manifest.packages) expect(sha256(readFileSync(join(destination, pkg.file)))).toBe(pkg.sha256);
    expect(existsSync(join(destination, 'gatopago-shared-3.2.0.tgz'))).toBe(false);
  });

  it('rejects a collision in a later consumer before changing an earlier consumer', () => {
    const { root, source, manifest } = fixture();
    const first = join(root, 'first'), second = join(root, 'second');
    mkdirSync(second);
    const existing = join(second, manifest.packages[2].file);
    writeFileSync(existing, 'original release');
    expect(() => copySdkRelease(source, [first, second])).toThrow('version collision');
    expect(existsSync(first)).toBe(false);
    expect(readFileSync(existing, 'utf8')).toBe('original release');
  });

  it('preserves all archives and the old manifest when promotion collides', () => {
    const { root, source, manifest } = fixture();
    const destination = join(root, 'releases');
    mkdirSync(destination);
    writeFileSync(join(destination, 'manifest.json'), 'original manifest');
    writeFileSync(join(destination, manifest.packages[2].file), 'original archive');
    expect(() => promoteSdkRelease(source, destination)).toThrow('version collision');
    expect(existsSync(join(destination, manifest.packages[0].file))).toBe(false);
    expect(readFileSync(join(destination, 'manifest.json'), 'utf8')).toBe('original manifest');
  });

  it('supports idempotent promotion without replacing matching archives', () => {
    const { root, source } = fixture();
    const destination = join(root, 'releases');
    promoteSdkRelease(source, destination);
    promoteSdkRelease(source, destination);
    expect(readSdkRelease(destination)).toEqual(readSdkRelease(source));
  });

  it('rejects a modified archive before writing a destination', () => {
    const { root, source, manifest } = fixture();
    writeFileSync(join(source, manifest.packages[2].file), 'tampered');
    const destination = join(root, 'consumer');
    expect(() => copySdkRelease(source, [destination])).toThrow('Archive integrity');
    expect(existsSync(destination)).toBe(false);
  });

  it('rejects paths outside the release directory', () => {
    const { source, manifest, save } = fixture();
    manifest.packages[0].file = '../outside.tgz'; save();
    expect(() => readSdkRelease(source)).toThrow('Invalid archive path');
  });

  it('rejects missing or duplicated packages', () => {
    const { source, manifest, save } = fixture();
    manifest.packages[2] = manifest.packages[0]; save();
    expect(() => readSdkRelease(source)).toThrow('Duplicate SDK package');
    manifest.packages.pop(); save();
    expect(() => readSdkRelease(source)).toThrow('Incomplete SDK release');
  });
});
