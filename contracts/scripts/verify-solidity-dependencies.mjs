// Offline build guard; --baseline-upstream can create a manifest ONLY after matching
// local sources to Git blobs in the exact locked commits. It never updates a library.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = new URL("../dependency-integrity.json", import.meta.url);
const lock = JSON.parse(readFileSync(join(root, "foundry.lock"), "utf8"));
const repositories = {
	"lib/forge-std": "https://github.com/foundry-rs/forge-std.git",
	"lib/openzeppelin-contracts": "https://github.com/OpenZeppelin/openzeppelin-contracts.git",
};
const submoduleRepositories = {
	"https://github.com/OpenZeppelin/openzeppelin-contracts.git": {
		"lib/forge-std": "https://github.com/foundry-rs/forge-std.git",
		"lib/erc4626-tests": "https://github.com/a16z/erc4626-tests.git",
		"lib/halmos-cheatcodes": "https://github.com/a16z/halmos-cheatcodes.git",
	},
};
const metadata = new Set([".gitattributes", ".gitmodules", "foundry.toml", "remappings.txt", "package.json", "LICENSE", "LICENSE-APACHE", "LICENSE-MIT"]);
const selected = (path) => /\.(sol|yul|vy)$/.test(path) || metadata.has(path.split("/").at(-1));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

assert.deepEqual(Object.keys(lock).sort(), Object.keys(repositories).sort(), "Every locked dependency needs an explicit reviewed repository");
for (const dependency of Object.keys(repositories)) assert.match(lock[dependency]?.tag?.rev ?? "", /^[0-9a-f]{40}$/, "Pin a full commit, not a moving branch");

function scan(directory) {
	const files = [];
	function walk(relative = "") {
		for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			assert(!entry.isSymbolicLink(), `Unreviewed dependency symlink: ${path}`);
			if (entry.isDirectory()) walk(path);
			else if (selected(path)) {
				assert(entry.isFile(), `Expected ordinary dependency file: ${path}`);
				assert(lstatSync(join(directory, path)).size <= 4 * 1024 * 1024, `Unexpected source size: ${path}`);
				const bytes = readFileSync(join(directory, path));
				files.push({ path, bytes: bytes.length, gitBlob: blobId(bytes), sha256: sha256(bytes) });
			}
		}
	}
	walk();
	return files.sort((a, b) => order(a.path, b.path));
}

function compare(actual, expected) {
	const actualMap = new Map(actual.map((entry) => [entry.path, entry]));
	const expectedMap = new Map(expected.map((entry) => [entry.path, entry]));
	assert.equal(actualMap.size, actual.length, "Duplicate local dependency path");
	assert.equal(expectedMap.size, expected.length, "Duplicate pinned dependency path");
	const differences = [];
	for (const entry of expected) {
		const local = actualMap.get(entry.path);
		if (!local) differences.push(`missing ${entry.path}`);
		else if (local.gitBlob !== entry.gitBlob || (entry.sha256 && local.sha256 !== entry.sha256) || (entry.bytes !== undefined && local.bytes !== entry.bytes)) differences.push(`changed ${entry.path}`);
	}
	for (const entry of actual) if (!expectedMap.has(entry.path)) differences.push(`unexpected ${entry.path}`);
	return differences;
}

function selfTest() {
	const file = { path: "src/A.sol", bytes: 1, gitBlob: "a".repeat(40), sha256: "b".repeat(64) };
	assert.deepEqual(compare([file], [file]), []);
	assert.deepEqual(compare([], [file]), ["missing src/A.sol"]);
	assert.deepEqual(compare([{ ...file, gitBlob: "c".repeat(40) }], [file]), ["changed src/A.sol"]);
	assert.deepEqual(compare([{ ...file, sha256: "c".repeat(64) }], [file]), ["changed src/A.sol"]);
	assert.deepEqual(compare([{ ...file, bytes: 2 }], [file]), ["changed src/A.sol"]);
	assert.deepEqual(compare([file, { ...file, path: "src/Unreviewed.sol" }], [file]), ["unexpected src/Unreviewed.sol"]);
	assert.throws(() => compare([file, file], [file]), /Duplicate/);
	assert.notEqual(blobId(Buffer.from("line\n")), blobId(Buffer.from("line\r\n")), "Bytecode provenance must not silently normalize source bytes");
}
selfTest();
assert(!process.argv.includes("--normalize-eol") || process.argv.includes("--baseline-upstream"), "EOL normalization requires upstream verification");

if (process.argv.includes("--baseline-upstream")) {
	const tempParent = realpathSync(tmpdir());
	const temporary = mkdtempSync(join(tempParent, "gatopago-v3-deps-"));
	const dependencies = [];
	const normalizations = [];
	let fetchIndex = 0;
	try {
		function upstream(repository, revision, prefix = "", depth = 0) {
			assert(depth <= 4 && fetchIndex < 16, "Unexpected dependency recursion");
			const clone = join(temporary, `repo-${fetchIndex++}`);
			const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
			git(["init", "--bare", "--quiet", clone]);
			git(["-C", clone, "fetch", "--quiet", "--no-tags", "--depth=1", repository, revision]);
			assert.equal(git(["-C", clone, "rev-parse", "FETCH_HEAD^{commit}"]).trim(), revision, "Fetched commit mismatch");
			const tree = git(["-C", clone, "ls-tree", "-rz", "--full-tree", revision]).split("\0").filter(Boolean).map((record) => {
				const match = record.match(/^(\d+) (\w+) ([0-9a-f]{40})\t([\s\S]+)$/);
				assert(match, "Invalid Git tree entry");
				return { mode: match[1], type: match[2], gitBlob: match[3], path: match[4] };
			});
			const files = tree.filter((entry) => selected(entry.path)).map((entry) => ({ ...entry, path: `${prefix}${entry.path}` }));
			const submodules = [];
			for (const entry of tree.filter((item) => item.mode === "160000")) {
				const childRepository = submoduleRepositories[repository]?.[entry.path];
				assert(childRepository, `Unreviewed submodule ${repository}:${entry.path}; never follow arbitrary Git URLs`);
				console.log(`Verifying nested dependency ${prefix}${entry.path} at ${entry.gitBlob}`);
				const child = upstream(childRepository, entry.gitBlob, `${prefix}${entry.path}/`, depth + 1);
				files.push(...child.files);
				submodules.push({ path: `${prefix}${entry.path}`, repository: childRepository, revision: entry.gitBlob }, ...child.submodules);
			}
			return { files: files.sort((a, b) => order(a.path, b.path)), submodules: submodules.sort((a, b) => order(a.path, b.path)) };
		}
		for (const [path, repository] of Object.entries(repositories)) {
			const revision = lock[path].tag.rev;
			const localDirectory = join(root, path);
			const local = scan(localDirectory);
			console.log(`Verifying ${path} against pinned upstream commit ${revision}`);
			const verified = upstream(repository, revision);
			const expected = verified.files;
			for (const entry of expected) assert(entry.type === "blob" && ["100644", "100755"].includes(entry.mode), `Non-file upstream source: ${entry.path}`);
			if (process.argv.includes("--normalize-eol")) {
				for (let index = 0; index < local.length; index++) {
					const entry = local[index];
					const pinned = expected.find((item) => item.path === entry.path);
					if (!pinned || entry.gitBlob === pinned.gitBlob) continue;
					const file = join(localDirectory, entry.path);
					const bytes = readFileSync(file);
					const lf = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"));
					if (blobId(lf) !== pinned.gitBlob) continue; // A real content change is NEVER overwritten.
					normalizations.push({ file, beforeHash: sha256(bytes), bytes: lf });
					local[index] = { path: entry.path, bytes: lf.length, gitBlob: blobId(lf), sha256: sha256(lf) };
				}
			}
			const differences = compare(local, expected);
			if (differences.length) {
				// Diagnose EOL drift without accepting it: a deterministic build requires exact bytes.
				for (const difference of differences.filter((item) => item.startsWith("changed ")).slice(0, 8)) {
					const name = difference.slice(8);
					const bytes = readFileSync(join(localDirectory, name));
					const lf = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"));
					if (blobId(lf) === expected.find((entry) => entry.path === name).gitBlob) console.error(`CRLF-only drift (not accepted): ${path}/${name}`);
				}
				throw new Error(`${path}: ${differences.length} content differences; no baseline written\n${differences.slice(0, 20).join("\n")}`);
			}
			dependencies.push({ path, repository, revision, tag: lock[path].tag.name, submodules: verified.submodules, files: local });
			console.log(`Verified ${local.length} source/config files${process.argv.includes("--normalize-eol") ? " including staged EOL normalization" : " byte-for-byte"}`);
		}
		// No writes until every dependency passed. Reject concurrent edits and path redirection.
		for (const planned of normalizations) {
			const canonicalPath = realpathSync(planned.file);
			const within = relative(realpathSync(root), canonicalPath);
			assert(!within.startsWith("..") && !lstatSync(planned.file).isSymbolicLink(), "Normalization path escaped contracts");
			assert.equal(sha256(readFileSync(planned.file)), planned.beforeHash, "Dependency changed during verification");
		}
		for (const planned of normalizations) writeFileSync(planned.file, planned.bytes);
		for (const dependency of dependencies) assert.deepEqual(scan(join(root, dependency.path)), dependency.files, "Post-normalization content mismatch");
		const body = { schemaVersion: 1, selection: "all-sol-yul-vy-and-build-metadata-v1", dependencies };
		const output = { ...body, contentHash: `0x${sha256(JSON.stringify(body))}` };
		writeFileSync(manifestPath, JSON.stringify(output, null, 2) + "\n");
		console.log(`Generated pinned dependency integrity manifest ${output.contentHash}`);
		if (normalizations.length) console.log(`Normalized CRLF to LF in ${normalizations.length} verified dependency files; no semantic edits`);
	} finally {
		// Remove ONLY this invocation's scratch bare repos, never a workspace or installed library.
		const actual = realpathSync(temporary);
		assert.equal(dirname(actual), tempParent, "Unsafe scratch cleanup path");
		assert(basename(actual).startsWith("gatopago-v3-deps-"), "Unsafe scratch cleanup name");
		rmSync(actual, { recursive: true, force: false });
	}
} else {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.selection, "all-sol-yul-vy-and-build-metadata-v1");
	const { contentHash, ...body } = manifest;
	assert.equal(contentHash, `0x${sha256(JSON.stringify(body))}`, "Dependency manifest checksum differs");
	assert.deepEqual(manifest.dependencies.map((entry) => entry.path), Object.keys(repositories), "Dependency manifest coverage differs");
	let total = 0;
	for (const dependency of manifest.dependencies) {
		assert.equal(dependency.repository, repositories[dependency.path]);
		assert.equal(dependency.revision, lock[dependency.path].tag.rev, "Lock revision changed: verify against upstream before rebaselining");
		assert.equal(dependency.tag, lock[dependency.path].tag.name);
		const actual = scan(resolve(root, dependency.path));
		const differences = compare(actual, dependency.files);
		assert.equal(differences.length, 0, `${dependency.path} integrity failed:\n${differences.slice(0, 20).join("\n")}`);
		total += actual.length;
	}
	console.log(`Pinned Solidity dependency contents verified: ${total} source/config files; ${contentHash}`);
}
