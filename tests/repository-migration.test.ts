import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";

const repository = "https://github.com/TQuang122/hypatia";
const read = (path: string) => readFileSync(path, "utf8");

test("npm uses the Companion package and repository", () => {
	const manifest = JSON.parse(read("package.json"));
	const lock = JSON.parse(read("package-lock.json"));
	assert.equal(manifest.name, "@TQuang122/hypatia");
	assert.equal(manifest.publishConfig.access, "public");
	assert.equal(manifest.bin.hypatia, "bin/hypatia.js");
	assert.ok(manifest.dependencies["@companion-ai/alpha-hub"]);
	assert.equal(lock.name, manifest.name);
	assert.equal(lock.packages[""].name, manifest.name);
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.packages[""].version, manifest.version);
	assert.equal(manifest.repository.url, `git+${repository}.git`);
	assert.equal(manifest.homepage, `${repository}#readme`);
	assert.equal(manifest.bugs.url, `${repository}/issues`);
});

describe("release and deployment workflow repository identity", {
	skip: [".github/workflows/publish.yml", ".github/workflows/e2e.yml", ".github/workflows/deploy-website.yml"].some(existsSync)
		? false
		: "release and deployment workflows are absent from this checkout",
}, () => test("present workflows use only the Companion Hypatia scope", () => {
	const manifest = JSON.parse(read("package.json"));
	const tarballPrefix = manifest.name.replace(/^@/, "").replaceAll("/", "-");
	for (const path of [".github/workflows/publish.yml", ".github/workflows/e2e.yml"].filter(existsSync)) {
		const content = read(path);
		assert.ok(content.includes("@TQuang122/hypatia"), path);
		assert.doesNotMatch(content, /advaitpaliwal/i, path);
		assert.ok(content.includes(`${tarballPrefix}-`), path);
		if (path.endsWith("e2e.yml")) assert.ok(content.includes(`runner.temp }}/${tarballPrefix}-*.tgz`));
	}
	if (existsSync(".github/workflows/deploy-website.yml")) {
		assert.doesNotMatch(read(".github/workflows/deploy-website.yml"), /advaitpaliwal/i);
	}
}));

test("research source request identities use the Companion repository", () => {
	for (const name of readdirSync("extensions/research-tools").filter((name) => name.endsWith(".ts"))) {
		assert.doesNotMatch(read(`extensions/research-tools/${name}`), /advaitpaliwal/i, name);
	}
});

test("installation docs name the current npm package", () => {
	for (const path of ["website/src/content/docs/getting-started/installation.md"]) {
		const content = read(path);
		assert.ok(content.includes("@TQuang122/hypatia"), path);
	}
});

test("installers and their public copies use the Companion owner directly", () => {
	for (const [source, published] of [
		["install.sh", "install"],
		["install.ps1", "install.ps1"],
		["install-skills.sh", "install-skills"],
		["install-skills.ps1", "install-skills.ps1"],
	]) {
		const installer = read(`scripts/install/${source}`);
		assert.ok(installer.includes(`${repository}/releases/latest`), source);
		assert.doesNotMatch(installer, /advaitpaliwal/i);
		assert.equal(read(`website/public/${published}`), installer);
	}
});

test("public source links do not depend on old-owner redirects", () => {
	for (const path of [
		"README.md",
		"CONTRIBUTING.md",
		"website/src/layouts/main.astro",
		"website/src/pages/index.astro",
	]) {
		const content = read(path);
		assert.ok(content.includes(repository), path);
		assert.doesNotMatch(content, /github\.com\/advaitpaliwal(?:\/|%2f)hypatia|advaitpaliwal%2Fhypatia/i, path);
	}
});
