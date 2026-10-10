import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const definitions = [
	{ name: "evidence-scout" },
	{ name: "scribe", alias: "writer" },
	{ name: "auditor", alias: "verifier" },
	{ name: "critic" },
	{ name: "reviser", alias: "patcher" },
];

test("bundled subagents expose the canonical names and non-conflicting aliases", () => {
	for (const definition of definitions) {
		const source = readFileSync(join(process.cwd(), ".hypatia", "agents", `${definition.name}.md`), "utf8");
		const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1];
		assert.ok(frontmatter, `${definition.name}.md must have frontmatter`);
		assert.match(frontmatter, new RegExp(`^name:\\s*${definition.name}\\s*$`, "mu"));
		if (definition.alias) {
			assert.match(frontmatter, new RegExp(`^aliases:\\s*${definition.alias}\\s*$`, "mu"));
		} else {
			assert.doesNotMatch(frontmatter, /^aliases:\s*(?:researcher|reviewer)\s*$/mu);
		}
	}
});
