import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildHelpSections } from "../extensions/research-tools/help.js";
import { readPromptSpecs } from "../metadata/commands.mjs";
import { parse as parseYaml } from "yaml";

test("wiki prompt is available in grouped help as a slash-only project command", () => {
	const spec = readPromptSpecs(process.cwd()).find((item: { name: string }) => item.name === "wiki");
	assert.ok(spec);
	assert.equal(spec.section, "Project & Session");
	assert.equal(spec.topLevelCli, false);
	assert.match(spec.args, /init\|ingest.*apply.*query.*lint/u);
	assert.match(spec.description, /source\/concept folders/u);
	const prompt = readFileSync(new URL("../prompts/wiki.md", import.meta.url), "utf8");
	const frontmatter = prompt.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1];
	assert.ok(frontmatter);
	const piMetadata = parseYaml(frontmatter) as Record<string, unknown>;
	assert.equal(piMetadata["argument-hint"], "[init|ingest <source>|apply <proposal>|query <question>|lint]");

	const sections = buildHelpSections({
		getCommands: () => [{ name: "wiki", description: spec.description }],
	} as any);
	const listed = sections.find((section) => section.title === "Project & Session")?.commands ?? [];
	assert.ok(listed.some((command) => command.usage.startsWith("/wiki ")));
});

test("wiki workflow separates source evidence, pending proposals, and approved project pages", () => {
	const prompt = readFileSync(new URL("../prompts/wiki.md", import.meta.url), "utf8");
	assert.match(prompt, /current workspace's explicit `wiki\/` directory/u);
	assert.match(prompt, /Raw research source files/u);
	assert.match(prompt, /wiki\/\.proposals\//u);
	assert.match(prompt, /wiki\/README\.md/u);
	assert.match(prompt, /claims table/iu);
	assert.match(prompt, /original citation\/locator/u);
	assert.match(prompt, /Do not edit `wiki\/index\.md`.*during ingest/u);
	assert.match(prompt, /explicitly confirm this application/u);
	assert.match(prompt, /query[\s\S]*?Do not modify files/u);
	assert.match(prompt, /lint[\s\S]*?do not edit files/u);
	const wikiSkill = readFileSync(new URL("../skills/research-wiki/SKILL.md", import.meta.url), "utf8");
	assert.match(wikiSkill, /Treat wiki pages as a navigation aid/u);
	assert.match(wikiSkill, /Do not edit canonical wiki pages directly/u);
	assert.match(wikiSkill, /`\/lit`.*`\/deepresearch`.*`\/compare`.*`\/replicate`/u);
	assert.match(wikiSkill, /knowledgePaths/u);
	assert.match(wikiSkill, /Exclude `wiki\/\.proposals\//u);
});

test("wiki init creates category directories and query tolerates an incomplete wiki", () => {
	const prompt = readFileSync(new URL("../prompts/wiki.md", import.meta.url), "utf8");
	assert.match(prompt, /If `wiki\/` already exists[\s\S]*?This only creates missing directories and preserves all existing content/u);
	assert.match(prompt, /run `mkdir -p wiki\/sources wiki\/concepts`/u);
	assert.match(prompt, /verify both directories exist/u);
	assert.match(prompt, /For a new wiki, also create/u);
	assert.match(prompt, /Missing `wiki\/sources\/` or `wiki\/concepts\/` directories count as empty categories/u);
	assert.match(prompt, /check that a directory exists before scanning it/u);
});

test("research workflows consult relevant wiki pages as read-only leads and verify original sources", () => {
	for (const file of ["../prompts/lit.md", "../prompts/deepresearch.md"]) {
		const prompt = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.match(prompt, /wiki\/README\.md/u);
		assert.match(prompt, /wiki\/index\.md/u);
		assert.match(prompt, /original sources?/iu);
		assert.match(prompt, /read.only|do not (?:edit|modify).*wiki/iu);
		assert.match(prompt, /links outside `wiki\//u);
		assert.match(prompt, /do not create it/u);
		assert.match(prompt, /provenance/u);
	}
});

test("compare and replicate consult indexed wiki pages as read-only context", () => {
	for (const file of ["../prompts/compare.md", "../prompts/replicate.md"]) {
		const prompt = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.match(prompt, /Project wiki context \(read-only\)/u);
		assert.match(prompt, /wiki\/README\.md/u);
		assert.match(prompt, /wiki\/index\.md/u);
		assert.match(prompt, /relevant indexed links/u);
		assert.match(prompt, /wiki\/\.proposals\//u);
		assert.match(prompt, /original sources?/iu);
		assert.match(prompt, /record.*wiki page paths/iu);
	}
	for (const name of ["compare", "replicate"]) {
		const spec = readPromptSpecs(process.cwd()).find((item: { name: string }) => item.name === name);
		assert.ok(spec?.description.includes("project wiki"));
	}
});

test("research leads pass scoped wiki claims to evidence-scout briefs", () => {
	for (const file of ["../prompts/lit.md", "../prompts/deepresearch.md", "../prompts/compare.md", "../prompts/replicate.md"]) {
		const prompt = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.match(prompt, /per-evidence-scout brief/u);
		assert.match(prompt, /claims?[^.]{0,100}status/iu);
		assert.match(prompt, /source IDs? and original URLs?/u);
		assert.match(prompt, /verify.*original source/iu);
	}
	const scout = readFileSync(new URL("../.hypatia/agents/evidence-scout.md", import.meta.url), "utf8");
	assert.match(scout, /Project wiki leads supplied by the parent/u);
	assert.match(scout, /navigation leads, not primary evidence/u);
	assert.match(scout, /Project wiki pages consulted/u);
	assert.match(scout, /Never edit canonical wiki pages/u);
});
