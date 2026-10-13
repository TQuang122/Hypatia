import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const appRoot = process.cwd();

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createNativeInstallerFixture(versions: string[]) {
	const root = mkdtempSync(join(tmpdir(), "hypatia-native-installer-"));
	const releaseRoot = join(root, "release");
	const installRoot = join(root, "install");
	const binRoot = join(root, "bin");
	const home = join(root, "home");
	const platform = process.platform === "darwin" ? "darwin" : "linux";
	const architecture = process.arch === "arm64" ? "arm64" : "x64";
	const archiveEntries: string[] = [];

	mkdirSync(releaseRoot, { recursive: true });
	mkdirSync(home, { recursive: true });
	for (const version of versions) {
		const bundleName = `hypatia-${version}-${platform}-${architecture}`;
		const bundleRoot = join(root, bundleName);
		const archiveName = `${bundleName}.tar.gz`;
		const archivePath = join(releaseRoot, archiveName);
		mkdirSync(bundleRoot, { recursive: true });
		const launcher = join(bundleRoot, "hypatia");
		writeFileSync(launcher, `#!/bin/sh
case "\${1:-}" in
  --version) printf '%s\\n' "${version}" ;;
  --help) printf '%s\\n' "Hypatia test help" ;;
  *) printf '%s\\n' "Hypatia test" ;;
esac
`);
		chmodSync(launcher, 0o755);
		assert.equal(spawnSync("tar", ["-czf", archivePath, "-C", root, bundleName]).status, 0);
		archiveEntries.push(`${sha256(archivePath)}  ${archiveName}`);
	}
	writeFileSync(join(releaseRoot, "SHA256SUMS"), `${archiveEntries.join("\n")}\n`);

	const env = {
		...process.env,
		HOME: home,
		HYPATIA_INSTALL_APP_DIR: installRoot,
		HYPATIA_INSTALL_BIN_DIR: binRoot,
		HYPATIA_INSTALL_BASE_URL: pathToFileURL(releaseRoot).href.replace(/\/$/u, ""),
		HYPATIA_INSTALL_SKIP_PATH_UPDATE: "1",
	};
	const install = (version: string, overrides: NodeJS.ProcessEnv = {}) => spawnSync(
		"sh",
		[join(appRoot, "scripts", "install", "install.sh"), version],
		{ cwd: appRoot, env: { ...env, ...overrides }, encoding: "utf8" },
	);
	return { root, installRoot, binRoot, env, install, platform, architecture };
}

test("native installer preserves an unrelated hpt command", { skip: process.platform === "win32" }, () => {
	const versions = ["9.8.7", "9.8.8"];
	const fixture = createNativeInstallerFixture(versions);
	const firstInstall = fixture.install(versions[0]!);
	assert.equal(firstInstall.status, 0, firstInstall.stderr);

	const userHpt = join(fixture.binRoot, "hpt");
	const userCommand = "#!/bin/sh\nprintf 'user hpt\\n'\n";
	writeFileSync(userHpt, userCommand);
	const replacement = fixture.install(versions[1]!);

	assert.notEqual(replacement.status, 0);
	assert.match(replacement.stderr, /existing hpt command.*leaving it untouched/i);
	assert.equal(readFileSync(userHpt, "utf8"), userCommand);
	const hypatiaVersion = spawnSync(join(fixture.binRoot, "hypatia"), ["--version"], { encoding: "utf8", env: fixture.env });
	assert.equal(hypatiaVersion.status, 0, hypatiaVersion.stderr);
	assert.equal(hypatiaVersion.stdout.trim(), versions[0]);
	assert.equal(existsSync(join(fixture.installRoot, `hypatia-${versions[1]}-${fixture.platform}-${fixture.architecture}`)), false);
});

test("native installer rolls back the existing launchers when installing the hpt shim fails", { skip: process.platform === "win32" }, () => {
	const versions = ["9.8.7", "9.8.8"];
	const fixture = createNativeInstallerFixture(versions);
	const firstInstall = fixture.install(versions[0]!);
	assert.equal(firstInstall.status, 0, firstInstall.stderr);
	const oldHypatiaShim = readFileSync(join(fixture.binRoot, "hypatia"), "utf8");
	const oldHptShim = readFileSync(join(fixture.binRoot, "hpt"), "utf8");
	const mockBin = join(fixture.root, "mock-bin");
	mkdirSync(mockBin, { recursive: true });
	const mvWrapper = join(mockBin, "mv");
	writeFileSync(mvWrapper, `#!/bin/sh
last_arg=
for arg do last_arg=$arg; done
case "\${1:-}" in
  */hpt-shim-candidate)
    if [ "\${HYPATIA_INSTALL_TEST_FAIL_HPT_SHIM:-0}" = 1 ] && [ "$last_arg" = "\${HYPATIA_INSTALL_BIN_DIR}/hpt" ]; then
  echo "injected hpt shim move failure" >&2
  exit 73
    fi
    ;;
esac
exec /bin/mv "$@"
`);
	chmodSync(mvWrapper, 0o755);
	const failedUpgrade = fixture.install(versions[1]!, {
		PATH: `${mockBin}:${process.env.PATH ?? ""}`,
		HYPATIA_INSTALL_TEST_FAIL_HPT_SHIM: "1",
	});

	assert.notEqual(failedUpgrade.status, 0);
	assert.match(failedUpgrade.stderr, /injected hpt shim move failure/u);
	assert.equal(readFileSync(join(fixture.binRoot, "hypatia"), "utf8"), oldHypatiaShim);
	assert.equal(readFileSync(join(fixture.binRoot, "hpt"), "utf8"), oldHptShim);
	for (const command of ["hypatia", "hpt"]) {
		const result = spawnSync(join(fixture.binRoot, command), ["--version"], { encoding: "utf8", env: fixture.env });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), versions[0]);
	}
	assert.equal(existsSync(join(fixture.installRoot, `hypatia-${versions[0]}-${fixture.platform}-${fixture.architecture}`)), true);
	assert.equal(existsSync(join(fixture.installRoot, `hypatia-${versions[1]}-${fixture.platform}-${fixture.architecture}`)), false);
});

test("native installer verifies checksums and preserves a working install on failure", {
	skip: process.platform === "win32",
}, () => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-native-installer-"));
	const releaseRoot = join(root, "release");
	const installRoot = join(root, "install");
	const binRoot = join(root, "bin");
	const home = join(root, "home");
	const version = "9.8.7";
	const platform = process.platform === "darwin" ? "darwin" : "linux";
	const architecture = process.arch === "arm64" ? "arm64" : "x64";
	const bundleName = `hypatia-${version}-${platform}-${architecture}`;
	const bundleRoot = join(root, bundleName);
	const archiveName = `${bundleName}.tar.gz`;
	const archivePath = join(releaseRoot, archiveName);
	const installedBundle = join(installRoot, bundleName);

	mkdirSync(bundleRoot, { recursive: true });
	mkdirSync(releaseRoot, { recursive: true });
	mkdirSync(home, { recursive: true });
	const launcher = join(bundleRoot, "hypatia");
	writeFileSync(launcher, `#!/bin/sh
case "\${1:-}" in
  --version) printf '%s\\n' "${version}" ;;
  --help) printf '%s\\n' "Hypatia test help" ;;
  *) printf '%s\\n' "Hypatia test" ;;
esac
`);
	chmodSync(launcher, 0o755);
	assert.equal(spawnSync("tar", ["-czf", archivePath, "-C", root, bundleName]).status, 0);
	writeFileSync(join(releaseRoot, "SHA256SUMS"), `${sha256(archivePath)}  ${archiveName}\n`);

	const env = {
		...process.env,
		HOME: home,
		HYPATIA_INSTALL_APP_DIR: installRoot,
		HYPATIA_INSTALL_BIN_DIR: binRoot,
		HYPATIA_INSTALL_BASE_URL: pathToFileURL(releaseRoot).href.replace(/\/$/, ""),
		HYPATIA_INSTALL_SKIP_PATH_UPDATE: "1",
	};
	const install = () => spawnSync(
		"sh",
		[join(appRoot, "scripts", "install", "install.sh"), version],
		{ cwd: appRoot, env, encoding: "utf8" },
	);

	const first = install();
	assert.equal(first.status, 0, first.stderr);
	assert.equal(existsSync(join(binRoot, "hypatia")), true);
	assert.equal(existsSync(join(binRoot, "hpt")), true);
	assert.equal(readFileSync(join(binRoot, "hpt"), "utf8"), readFileSync(join(binRoot, "hypatia"), "utf8"));
	const aliasVersion = spawnSync(join(binRoot, "hpt"), ["--version"], { encoding: "utf8", env });
	assert.equal(aliasVersion.status, 0, aliasVersion.stderr);
	assert.equal(aliasVersion.stdout.trim(), version);
	assert.equal(existsSync(installedBundle), true);

	const replacementSentinel = join(installedBundle, "replace-me.sentinel");
	writeFileSync(replacementSentinel, "remove me\n");
	const obsoleteBundle = join(installRoot, "hypatia-1.0.0-old");
	mkdirSync(obsoleteBundle, { recursive: true });
	const replacement = install();
	assert.equal(replacement.status, 0, replacement.stderr);
		assert.equal(existsSync(replacementSentinel), false);
		assert.equal(existsSync(obsoleteBundle), false);

		const duplicateSentinel = join(installedBundle, "duplicate-checksum-must-preserve.sentinel");
		writeFileSync(duplicateSentinel, "keep me\n");
		const validChecksum = sha256(archivePath);
		for (const checksumLines of [
			`${validChecksum}  ${archiveName}\n${"0".repeat(64)}  ${archiveName}\n`,
			`${"0".repeat(64)}  ${archiveName}\n${validChecksum}  ${archiveName}\n`,
		]) {
			writeFileSync(join(releaseRoot, "SHA256SUMS"), checksumLines);
			const duplicateRejected = install();
			assert.notEqual(duplicateRejected.status, 0);
			assert.match(duplicateRejected.stderr, /multiple checksum entries/);
			assert.equal(existsSync(duplicateSentinel), true);
		}

		const preservedSentinel = join(installedBundle, "preserve-me.sentinel");
		writeFileSync(preservedSentinel, "keep me\n");
		writeFileSync(join(releaseRoot, "SHA256SUMS"), `${validChecksum}  ${archiveName}\n`);
		appendFileSync(archivePath, "corrupt");
	const rejected = install();
	assert.notEqual(rejected.status, 0);
	assert.match(rejected.stderr, /SHA-256 mismatch/);
	assert.equal(existsSync(preservedSentinel), true);
});
