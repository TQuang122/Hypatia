import assert from "node:assert/strict";
import test from "node:test";

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

import { ProvenanceComparisonView } from "../extensions/provenance-compare.js";
import {
	compareProvenanceRecords,
	parseProvenanceSidecar,
} from "../extensions/research-tools/provenance-review.js";

test("compare provenance fields without inferring source changes", () => {
	const earlier = parseProvenanceSidecar(
		"outputs/earlier.provenance.md",
		[
			"# Provenance: Retrieval Study",
			"- **Date:** 2026-10-01",
			"- **Rounds:** 2",
			"- **Sources consulted:** 8 papers",
			"- **Sources accepted:** 5 papers",
			"- **Sources rejected:** 3 papers",
			"- **Verification:** PASS",
		].join("\n"),
	);
	const later = parseProvenanceSidecar(
		"outputs/later.provenance.md",
		[
			"# Provenance: Retrieval Study",
			"- **Date:** 2026-10-01",
			"- **Rounds:** 3",
			"- **Sources consulted:** 10 papers",
			"- **Sources accepted:** 6 papers",
			"- **Sources rejected:** 4 papers",
			"- **Verification:** PASS WITH NOTES",
		].join("\n"),
	);

	assert.deepEqual(
		compareProvenanceRecords(earlier, later),
		[
			{ field: "Rounds", before: "2", after: "3" },
			{ field: "Sources consulted", before: "8 papers", after: "10 papers" },
			{ field: "Sources accepted", before: "5 papers", after: "6 papers" },
			{ field: "Sources rejected", before: "3 papers", after: "4 papers" },
			{ field: "Verification", before: "PASS", after: "PASS WITH NOTES" },
		],
	);
});

test("compare identical provenance values regardless of artifact path", () => {
	const earlier = parseProvenanceSidecar(
		"outputs/earlier.provenance.md",
		"# Provenance: Study\n- **Verification:** BLOCKED",
	);
	const later = parseProvenanceSidecar(
		"papers/later.provenance.md",
		"# Provenance: Another title\n- **Verification:** BLOCKED",
	);

	assert.deepEqual(compareProvenanceRecords(earlier, later), []);
});

test("comparison overlay fits narrow and wide widths and handles scrolling", () => {
	const earlier = parseProvenanceSidecar(
		"outputs/earlier.provenance.md",
		[
			"# Provenance: Earlier",
			"- **Date:** 2026-10-01",
			"- **Rounds:** 2",
			"- **Sources consulted:** 8 papers",
			"- **Sources accepted:** 5 papers",
			"- **Sources rejected:** 3 papers",
			"- **Verification:** PASS",
		].join("\n"),
	);
	const later = parseProvenanceSidecar(
		"papers/later.provenance.md",
		[
			"# Provenance: Later",
			"- **Date:** 2026-10-02",
			"- **Rounds:** 3",
			"- **Sources consulted:** 10 papers",
			"- **Sources accepted:** 6 papers",
			"- **Sources rejected:** 4 papers",
			"- **Verification:** BLOCKED",
		].join("\n"),
	);
	let renderRequests = 0;
	let closed = false;
	const tui = { requestRender: () => { renderRequests += 1; } } satisfies Pick<TUI, "requestRender">;
	const theme = {
		fg: (_color: ThemeColor, text: string) => text,
		bold: (text: string) => text,
	} satisfies Pick<Theme, "fg" | "bold">;
	const view = new ProvenanceComparisonView(tui, theme, earlier, later, () => { closed = true; });

	const narrow = view.render(48);
	const wide = view.render(120);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 48));
	assert.ok(wide.every((line) => visibleWidth(line) <= 120));
	assert.ok(narrow.some((line) => line.includes("outputs/earlier.provenance.md")));
	assert.ok(narrow.some((line) => line.includes("papers/later.provenance.md")));
	assert.ok(narrow.some((line) => line.includes("Enter/Esc close")));
	assert.ok(narrow.some((line) => line.includes("BLOCKED")));

	const beforeScroll = view.render(48);
	view.handleInput("\u001b[B");
	assert.equal(renderRequests, 1);
	const afterScroll = view.render(48);
	assert.notDeepEqual(afterScroll, beforeScroll);

	view.handleInput("\u001b");
	assert.equal(closed, true);
});
