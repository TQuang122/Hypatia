import assert from "node:assert/strict";
import test from "node:test";

import { extractCitationSources } from "../extensions/research-tools/citation-sources.js";

test("source extraction keeps titles, DOI/arXiv identifiers, and only explicit verification", () => {
	assert.deepEqual(extractCitationSources([
		"[Scaling laws](https://example.org/paper) — Verification status: verified",
		"DOI: 10.1234/example.2",
		"arXiv: 2401.12345v2",
	].join("\n")), [
		{ title: "Scaling laws", url: "https://example.org/paper", verification: "verified" },
		{ title: "DOI:10.1234/example.2", url: "https://doi.org/10.1234/example.2", identifier: "DOI:10.1234/example.2" },
		{ title: "arXiv:2401.12345v2", url: "https://arxiv.org/abs/2401.12345v2", identifier: "arXiv:2401.12345v2" },
	]);
});
