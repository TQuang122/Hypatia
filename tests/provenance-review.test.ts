import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverProvenanceRecords, parseProvenanceSidecar } from "../extensions/research-tools/provenance-review.js";

test("parse provenance summary fields without guessing verification", () => {
	const record = parseProvenanceSidecar(
		"outputs/retrieval-study.provenance.md",
		[
			"# Provenance: Retrieval Study",
			"",
			"- **Date:** 2026-10-03",
			"- **Rounds:** 2",
			"- **Sources consulted:** 8 papers",
			"- **Sources accepted:** 5 papers",
			"- **Sources rejected:** 3 papers",
			"- **Verification:** PASS WITH NOTES",
		].join("\n"),
	);

	assert.equal(record.path, "outputs/retrieval-study.provenance.md");
	assert.equal(record.title, "Retrieval Study");
	assert.equal(record.verification, "PASS WITH NOTES");
	assert.equal(record.date, "2026-10-03");
	assert.equal(record.rounds, "2");
	assert.equal(record.sourcesConsulted, "8 papers");
	assert.equal(record.sourcesAccepted, "5 papers");
	assert.equal(record.sourcesRejected, "3 papers");

	const unknown = parseProvenanceSidecar("papers/legacy.provenance.md", "# Old record\n\n- **Verification:** complete");
	assert.equal(unknown.verification, "UNKNOWN");
});

test("blank provenance fields do not consume the next metadata line", () => {
	const record = parseProvenanceSidecar(
		"outputs/blank-fields.provenance.md",
		[
			"# Provenance: Blank fields",
			"- **Date:**",
			"- **Rounds:** 3",
			"- **Sources consulted:**",
			"- **Sources accepted:** PASS",
			"- **Sources rejected:**",
			"- **Verification:**",
		].join("\n"),
	);

	assert.equal(record.date, undefined);
	assert.equal(record.rounds, "3");
	assert.equal(record.sourcesConsulted, undefined);
	assert.equal(record.sourcesAccepted, "PASS");
	assert.equal(record.sourcesRejected, undefined);
	assert.equal(record.verification, "UNKNOWN");
});

test("discover only top-level provenance sidecars beside final outputs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "hypatia-provenance-"));
	try {
		await mkdir(join(cwd, "outputs", ".plans"), { recursive: true });
		await mkdir(join(cwd, "papers"), { recursive: true });
		await writeFile(join(cwd, "outputs", "retrieval-study.provenance.md"), "# Provenance: Retrieval Study\n- **Verification:** PASS");
		await writeFile(join(cwd, "papers", "review.provenance.md"), "# Provenance: Review\n- **Verification:** BLOCKED");
		await writeFile(join(cwd, "outputs", "retrieval-study.md"), "# Final result");
		await writeFile(join(cwd, "outputs", ".plans", "plan.provenance.md"), "# Not a final sidecar");

		const records = await discoverProvenanceRecords(cwd);

		assert.deepEqual(
			records.map((record) => record.path).sort(),
			["outputs/retrieval-study.provenance.md", "papers/review.provenance.md"].sort(),
		);
		assert.equal(records.find((record) => record.path === "outputs/retrieval-study.provenance.md")?.verification, "PASS");
		assert.equal(records.find((record) => record.path === "papers/review.provenance.md")?.verification, "BLOCKED");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
