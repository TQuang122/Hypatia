import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hash } from "../src/experiments/files.js";
import { nativeKnowledge } from "../src/idea-forge/knowledge.js";

test("native Idea Forge freezes selected wiki pages into a path-attributed knowledge bundle", async t => {
	const workspace = await mkdtemp(join(tmpdir(), "hypatia-wiki-bundle-"));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	await mkdir(join(workspace, "wiki/concepts"), { recursive: true });
	await mkdir(join(workspace, "wiki/sources"), { recursive: true });
	const concept = "# Retrieval evaluation\nKeep the test set closed during tuning.\n";
	const source = "# Benchmark paper\nDOI: 10.1234/example\n";
	await writeFile(join(workspace, "wiki/concepts/retrieval.md"), concept);
	await writeFile(join(workspace, "wiki/sources/benchmark.md"), source);

	const knowledge = await nativeKnowledge(workspace, "RAG evaluation", undefined, undefined, [
		"wiki/concepts/retrieval.md",
		"wiki/sources/benchmark.md",
	]);

	assert.equal(knowledge.id, "rag-evaluation");
	assert.match(knowledge.title, /project wiki context/u);
	assert.match(knowledge.text, /Evaluate the pipeline in separate stages/u);
	assert.match(knowledge.text, /prior project synthesis.*not primary evidence/iu);
	assert.match(knowledge.text, /wiki\/concepts\/retrieval\.md/u);
	assert.match(knowledge.text, /wiki\/sources\/benchmark\.md/u);
	assert.ok(knowledge.text.indexOf("wiki/concepts/retrieval.md") < knowledge.text.indexOf("wiki/sources/benchmark.md"));
	assert.deepEqual(knowledge.sources, [
		{ path: "wiki/concepts/retrieval.md", hash: hash(concept) },
		{ path: "wiki/sources/benchmark.md", hash: hash(source) },
	]);
	assert.equal(knowledge.hash, hash(knowledge.text));
});

test("native Idea Forge wiki bundles reject proposals, non-wiki paths, traversal, and oversized bundles", async t => {
	const workspace = await mkdtemp(join(tmpdir(), "hypatia-wiki-bounds-"));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	await mkdir(join(workspace, "wiki/.proposals"), { recursive: true });
	await mkdir(join(workspace, "wiki/concepts"), { recursive: true });
	await mkdir(join(workspace, "outside"), { recursive: true });
	await writeFile(join(workspace, "wiki/.proposals/pending.md"), "unapproved");
	await writeFile(join(workspace, "outside/secret.md"), "outside the wiki");
	await symlink(join(workspace, "outside/secret.md"), join(workspace, "wiki/concepts/linked.md"));
	await writeFile(join(workspace, "wiki/concepts/large-a.md"), "a".repeat(70 * 1024));
	await writeFile(join(workspace, "wiki/concepts/large-b.md"), "b".repeat(70 * 1024));

	await assert.rejects(nativeKnowledge(workspace, "topic", undefined, undefined, ["wiki/.proposals/pending.md"]), /accepted wiki pages/u);
	await assert.rejects(nativeKnowledge(workspace, "topic", undefined, undefined, ["wiki/concepts/.proposals/pending.md"]), /accepted wiki pages/u);
	await assert.rejects(nativeKnowledge(workspace, "topic", undefined, undefined, ["README.md"]), /accepted wiki pages/u);
	await assert.rejects(nativeKnowledge(workspace, "topic", undefined, undefined, ["../outside.md"]), /accepted wiki pages/u);
	await assert.rejects(nativeKnowledge(workspace, "topic", undefined, undefined, ["wiki/concepts/linked.md"]), /Symlink/u);
	await assert.rejects(nativeKnowledge(workspace, "topic", undefined, undefined, ["wiki/concepts/large-a.md", "wiki/concepts/large-b.md"]), /128 KiB/u);
	await assert.rejects(nativeKnowledge(workspace, "topic", undefined, undefined, Array.from({ length: 13 }, (_, i) => `wiki/concepts/page-${i}.md`)), /12 pages/u);
});
