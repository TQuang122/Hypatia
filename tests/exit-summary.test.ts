import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildExitSummary,
	extractSessionId,
	findRecentSessionId,
	formatElapsed,
	resolveReconnectCommand,
	shortenCwd,
	shouldPrintExitSummary,
} from "../src/pi/exit-summary.js";

test("formatElapsed renders codex-style durations", () => {
	assert.equal(formatElapsed(45_000), "45s");
	assert.equal(formatElapsed(1_695_000), "28m 15s");
	assert.equal(formatElapsed(3_723_000), "1h 2m 3s");
	assert.equal(formatElapsed(-100), "0s");
});

test("shortenCwd compresses the home prefix only", () => {
	assert.equal(shortenCwd("/Users/t/work/proj", "/Users/t"), "~/work/proj");
	assert.equal(shortenCwd("/Users/t", "/Users/t"), "~");
	assert.equal(shortenCwd("/other/dir", "/Users/t"), "/other/dir");
});

test("extractSessionId parses Pi session filenames", () => {
	assert.equal(
		extractSessionId("2026-10-03T10-13-45-196Z_01a10141-646b-73c5-ab03-48eeaf3f0d71.jsonl"),
		"01a10141-646b-73c5-ab03-48eeaf3f0d71",
	);
	assert.equal(extractSessionId("notes.md"), undefined);
	assert.equal(extractSessionId("no-separator.jsonl"), undefined);
});

test("findRecentSessionId picks the newest file since startup", () => {
	const dir = mkdtempSync(join(tmpdir(), "hypatia-exit-"));
	const start = Date.now();
	const oldFile = "2026-01-01T00-00-00-000Z_aaaa-old-session-id-0000.jsonl";
	const newFile = "2026-10-04T00-00-00-000Z_bbbb-new-session-id-1111.jsonl";
	writeFileSync(join(dir, oldFile), "{}\n");
	writeFileSync(join(dir, newFile), "{}\n");
	utimesSync(join(dir, oldFile), new Date(start - 3_600_000), new Date(start - 3_600_000));
	utimesSync(join(dir, newFile), new Date(start + 1000), new Date(start + 1000));
	assert.equal(findRecentSessionId(dir, start - 30_000), "bbbb-new-session-id-1111");
	assert.equal(findRecentSessionId(dir, start + 60_000), undefined);
	assert.equal(findRecentSessionId(join(dir, "missing"), start), undefined);
});

test("resolveReconnectCommand prefers explicit session, then recent file, then -c", () => {
	const dir = mkdtempSync(join(tmpdir(), "hypatia-exit-"));
	assert.equal(
		resolveReconnectCommand(["--session", "abc-123"], dir, Date.now()),
		"hypatia --session abc-123",
	);
	assert.equal(resolveReconnectCommand(["--no-session"], dir, Date.now()), undefined);
	assert.equal(resolveReconnectCommand([], dir, Date.now()), "hypatia -c");
});

test("shouldPrintExitSummary only for clean interactive TTY exits", () => {
	const base = { exitCode: 0, mode: undefined, oneShotPrompt: undefined, isTTY: true };
	assert.equal(shouldPrintExitSummary(base), true);
	assert.equal(shouldPrintExitSummary({ ...base, exitCode: 1 }), false);
	assert.equal(shouldPrintExitSummary({ ...base, isTTY: false }), false);
	assert.equal(shouldPrintExitSummary({ ...base, mode: "rpc" }), false);
	assert.equal(shouldPrintExitSummary({ ...base, mode: "json" }), false);
	assert.equal(shouldPrintExitSummary({ ...base, oneShotPrompt: "hi" }), false);
});

test("buildExitSummary mirrors the codex block shape", () => {
	const text = buildExitSummary({
		workingDir: "/Users/t/work/proj",
		elapsedMs: 1_695_000,
		reconnect: "hypatia --session abc-123",
		git: { branch: "aspidochelone", dirty: true },
		home: "/Users/t",
	});
	assert.equal(
		text,
		"~/work/proj  aspidochelone*  28m 15s\n❯ hypatia\nSession ended. Work is saved.\nTo reconnect, run:\n  hypatia --session abc-123\n",
	);
	const noGit = buildExitSummary({
		workingDir: "/tmp/x",
		elapsedMs: 5000,
		reconnect: undefined,
		home: "/Users/t",
	});
	assert.equal(noGit, "/tmp/x  5s\n❯ hypatia\nSession ended. Work is saved.\n");
});
