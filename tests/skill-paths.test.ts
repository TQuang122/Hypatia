import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repoRoot, "skills");
const markdownPathPattern = /`((?:\.\.?\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md)`/g;
const simulatedInstallRoot = join(repoRoot, "__skill-install-root__");

test("all local markdown references in bundled skills resolve in the installed skill layout", () => {
	for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;

		const skillPath = join(skillsRoot, entry.name, "SKILL.md");
		if (!existsSync(skillPath)) continue;

		const content = readFileSync(skillPath, "utf8");
		for (const match of content.matchAll(markdownPathPattern)) {
			const reference = match[1];
			const installedSkillDir = join(simulatedInstallRoot, entry.name);
			const installedTarget = resolve(installedSkillDir, reference);
			const repoTarget = join(skillsRoot, relative(simulatedInstallRoot, installedTarget));
			assert.ok(existsSync(repoTarget), `${skillPath} references missing installed markdown file ${reference}`);
		}
	}
});

test("every bundled skill has frontmatter with a matching name and a trigger description", () => {
	for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const skillPath = join(skillsRoot, entry.name, "SKILL.md");
		if (!existsSync(skillPath)) continue;
		const content = readFileSync(skillPath, "utf8");
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		assert.ok(match, `${skillPath} is missing YAML frontmatter`);
		const frontmatter = Object.fromEntries(
			match[1]!.split("\n").map((line) => {
				const separator = line.indexOf(":");
				return separator === -1 ? [] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
			}).filter((pair): pair is [string, string] => pair.length === 2),
		);
		assert.equal(frontmatter.name, entry.name, `${skillPath} frontmatter name must match its directory`);
		assert.ok((frontmatter.description ?? "").length > 20, `${skillPath} needs a trigger description`);
	}
});
