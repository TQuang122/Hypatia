import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	expandHomePath,
	ensureHypatiaHome,
	getBootstrapStatePath,
	getDefaultSessionDir,
	getHypatiaAgentDir,
	getHypatiaHome,
	getHypatiaMemoryDir,
	getHypatiaStateDir,
} from "../src/config/paths.js";

test("getHypatiaHome uses HYPATIA_HOME env var when set", () => {
	const previous = process.env.HYPATIA_HOME;
	try {
		process.env.HYPATIA_HOME = "/custom/home";
		assert.equal(getHypatiaHome(), resolve("/custom/home", ".hypatia"));
	} finally {
		if (previous === undefined) {
			delete process.env.HYPATIA_HOME;
		} else {
			process.env.HYPATIA_HOME = previous;
		}
	}
});

test("getHypatiaHome falls back to homedir when HYPATIA_HOME is unset", () => {
	const previous = process.env.HYPATIA_HOME;
	try {
		delete process.env.HYPATIA_HOME;
		const home = getHypatiaHome();
		assert.ok(home.endsWith(".hypatia"), `expected path ending in .hypatia, got: ${home}`);
		assert.ok(!home.includes("undefined"), `expected no 'undefined' in path, got: ${home}`);
	} finally {
		if (previous === undefined) {
			delete process.env.HYPATIA_HOME;
		} else {
			process.env.HYPATIA_HOME = previous;
		}
	}
});

test("getHypatiaAgentDir resolves to <home>/agent", () => {
	assert.equal(getHypatiaAgentDir("/some/home"), resolve("/some/home", "agent"));
});

test("getHypatiaMemoryDir resolves to <home>/memory", () => {
	assert.equal(getHypatiaMemoryDir("/some/home"), resolve("/some/home", "memory"));
});

test("getHypatiaStateDir resolves to <home>/.state", () => {
	assert.equal(getHypatiaStateDir("/some/home"), resolve("/some/home", ".state"));
});

test("getDefaultSessionDir resolves to <home>/sessions", () => {
	assert.equal(getDefaultSessionDir("/some/home"), resolve("/some/home", "sessions"));
});

test("getBootstrapStatePath resolves to <home>/.state/bootstrap.json", () => {
	assert.equal(getBootstrapStatePath("/some/home"), resolve("/some/home", ".state", "bootstrap.json"));
});

test("ensureHypatiaHome creates all required subdirectories", () => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-paths-"));
	try {
		const home = join(root, "home");
		ensureHypatiaHome(home);

		assert.ok(existsSync(home), "home dir should exist");
		assert.ok(existsSync(join(home, "agent")), "agent dir should exist");
		assert.ok(existsSync(join(home, "memory")), "memory dir should exist");
		assert.ok(existsSync(join(home, ".state")), ".state dir should exist");
		assert.ok(existsSync(join(home, "sessions")), "sessions dir should exist");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureHypatiaHome is idempotent when dirs already exist", () => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-paths-"));
	try {
		const home = join(root, "home");
		ensureHypatiaHome(home);
		assert.doesNotThrow(() => ensureHypatiaHome(home));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("HYPATIA_HOME expands a leading ~ like Pi's agent dir variable", () => {
	assert.equal(expandHomePath("~", "/home/u"), "/home/u");
	assert.equal(expandHomePath("~/research", "/home/u"), join("/home/u", "research"));
	assert.equal(expandHomePath("~\\research", "C:\\Users\\u"), join("C:\\Users\\u", "research"));
	assert.equal(expandHomePath("/abs/~/x", "/home/u"), "/abs/~/x");
	assert.equal(expandHomePath("~other/x", "/home/u"), "~other/x");
});
