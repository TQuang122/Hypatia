import test from "node:test";
import assert from "node:assert/strict";

import { fetchLatestHypatiaVersion, getHypatiaUpgradeLines, isNewerVersion } from "../src/system/self-update.js";

test("release discovery requests the personal package registry", async (t) => {
	const requests: unknown[] = [];
	t.mock.method(globalThis, "fetch", async (url: unknown) => {
		requests.push(url);
		return new Response(JSON.stringify({ version: "0.3.48" }));
	});
	assert.equal(await fetchLatestHypatiaVersion(), "0.3.48");
	assert.deepEqual(requests, ["https://registry.npmjs.org/@tquang122/hypatia/latest"]);
});

test("isNewerVersion compares release versions numerically", () => {
	assert.equal(isNewerVersion("0.2.59", "0.2.58"), true);
	assert.equal(isNewerVersion("0.3.0", "0.2.58"), true);
	assert.equal(isNewerVersion("1.0.0", "0.2.58"), true);
	assert.equal(isNewerVersion("0.2.58", "0.2.58"), false);
	assert.equal(isNewerVersion("0.2.57", "0.2.58"), false);
	assert.equal(isNewerVersion("0.2.10", "0.2.9"), true);
});

test("isNewerVersion rejects non-release version strings", () => {
	assert.equal(isNewerVersion("0.2.59-beta.1", "0.2.58"), false);
	assert.equal(isNewerVersion("latest", "0.2.58"), false);
	assert.equal(isNewerVersion("0.2.59", "unknown"), false);
});

test("getHypatiaUpgradeLines points npm installs at npm", () => {
	const lines = getHypatiaUpgradeLines("0.2.59", "0.2.58", { standaloneBundle: false, platform: "win32" });
	assert.equal(lines[0], "A newer Hypatia is available: 0.2.59 (installed 0.2.58).");
	assert.equal(lines[1], "Update the CLI itself with: npm install -g @tquang122/hypatia");
});

test("getHypatiaUpgradeLines points standalone bundles at the installer", () => {
	const windowsLines = getHypatiaUpgradeLines("0.2.59", "0.2.58", { standaloneBundle: true, platform: "win32" });
	assert.equal(windowsLines[1], "Update the CLI itself with: irm https://raw.githubusercontent.com/TQuang122/hypatia/main/scripts/install/install.ps1 | iex");

	const unixLines = getHypatiaUpgradeLines("0.2.59", "0.2.58", { standaloneBundle: true, platform: "darwin" });
	assert.equal(unixLines[1], "Update the CLI itself with: curl -fsSL https://raw.githubusercontent.com/TQuang122/hypatia/main/scripts/install/install.sh | bash");
});
