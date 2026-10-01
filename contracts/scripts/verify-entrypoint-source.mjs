// Offline provenance guard for the official EntryPoint source used by Foundry integration tests.
// No package scripts, deployment, credentials or network calls run here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const sourceRoot = dirname(require.resolve("@gatopago/entrypoint-source/package.json"));
const manifest = JSON.parse(readFileSync(new URL("../entrypoint-source-integrity.json", import.meta.url), "utf8"));
const revision = "b36a1ed52ae00da6f8a4c8d50181e2877e4fa410";
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.revision, revision);
assert.equal(manifest.repository, "https://github.com/eth-infinitism/account-abstraction");
assert.equal(manifest.selection, "archive-shipped-contracts-license-package-v1");
const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(rootPackage.devDependencies["@gatopago/entrypoint-source"], `https://codeload.github.com/eth-infinitism/account-abstraction/tar.gz/${revision}`);
const actual = [];
function walk(relative) {
  for (const entry of readdirSync(join(sourceRoot, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    assert(!entry.isSymbolicLink(), `Unexpected symlink in EntryPoint source: ${path}`);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".sol")) actual.push(path);
  }
}
walk("contracts");
actual.push("LICENSE", "package.json");
const expected = manifest.files.map((file) => file.path);
assert.deepEqual(actual.sort(), [...expected].sort(), "EntryPoint source inventory changed");
assert.equal(new Set(expected).size, expected.length);
function verifyContents(file, contents) {
  const blob = createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex");
  assert.equal(contents.length, file.bytes, `EntryPoint source size changed: ${file.path}`);
  assert.equal(blob, file.gitBlob, `EntryPoint source differs from pinned Git blob: ${file.path}`);
}
for (const file of manifest.files) {
  assert(!file.path.split("/").includes("..") && /^(contracts\/[\w/.-]+\.sol|LICENSE|package\.json)$/.test(file.path));
  const contents = readFileSync(join(sourceRoot, file.path));
  verifyContents(file, contents);
  // Negative evidence exercises the same verifier without touching installed dependency files.
  const changed = Buffer.from(contents);
  changed[0] ^= 1;
  assert.throws(() => verifyContents(file, changed), /differs from pinned Git blob/);
  assert.throws(() => verifyContents(file, contents.subarray(1)), /source size changed/);
}
console.log(`Official EntryPoint source verified: ${revision}, ${expected.length} pinned source/license/package files; content/size tamper tests pass. Not network deployment attestation.`);
