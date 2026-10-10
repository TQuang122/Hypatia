import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import {
	DEFAULT_POSTHOG_HOST,
	TELEMETRY_NOTICE,
	captureTelemetryException,
	captureTelemetryEventImmediate,
	createTelemetryCircuitBreakerFetch,
	getCliTelemetryMetadata,
	getPostHogChildEnv,
	initializePostHogTelemetry,
	normalizeTelemetryProperties,
	redactTelemetryText,
	resolvePostHogTelemetryConfig,
	shutdownPostHogTelemetry,
	telemetryErrorProperties,
	telemetryFirstRunNotice,
} from "../src/telemetry/posthog.js";


// tests/isolate-tmpdir.ts turns telemetry off for spawned CLIs; these tests stub the network.
delete process.env.HYPATIA_TELEMETRY;

const TEST_POSTHOG_KEY = "phc_testkey00000000000000000000000000";

function withTelemetryOptInEnv(run: () => Promise<void>): () => Promise<void> {
	return async () => {
		const previous = { HYPATIA_TELEMETRY: process.env.HYPATIA_TELEMETRY, HYPATIA_POSTHOG_KEY: process.env.HYPATIA_POSTHOG_KEY };
		process.env.HYPATIA_TELEMETRY = "1";
		process.env.HYPATIA_POSTHOG_KEY = TEST_POSTHOG_KEY;
		try {
			await run();
		} finally {
			await shutdownPostHogTelemetry();
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	};
}

test("resolvePostHogTelemetryConfig stays disabled without explicit opt-in", () => {
	const home = mkdtempSync(join(tmpdir(), "hypatia-telemetry-home-"));
	assert.equal(resolvePostHogTelemetryConfig({ home, env: {} }), undefined);
	assert.equal(resolvePostHogTelemetryConfig({ home, env: { HYPATIA_POSTHOG_KEY: TEST_POSTHOG_KEY } }), undefined);
	assert.equal(resolvePostHogTelemetryConfig({ home, env: { HYPATIA_TELEMETRY: "yes" } }), undefined);
});

test("resolvePostHogTelemetryConfig enables with opt-in and a project key", () => {
	const home = mkdtempSync(join(tmpdir(), "hypatia-telemetry-optin-home-"));
	const config = resolvePostHogTelemetryConfig({
		home,
		appVersion: "0.3.4",
		env: {
			HYPATIA_TELEMETRY: "1",
			HYPATIA_POSTHOG_KEY: TEST_POSTHOG_KEY,
		},
	});

	assert.equal(config?.host, DEFAULT_POSTHOG_HOST);
	assert.equal(config?.projectToken, TEST_POSTHOG_KEY);
	assert.equal(config?.appVersion, "0.3.4");
	assert.match(config?.distinctId ?? "", /^hypatia_/);

	const state = JSON.parse(readFileSync(join(home, ".state", "telemetry.json"), "utf8")) as { anonymousId?: string };
	assert.equal(state.anonymousId, config?.distinctId);
});

test("resolvePostHogTelemetryConfig respects telemetry opt out", () => {
	assert.equal(resolvePostHogTelemetryConfig({ env: { HYPATIA_TELEMETRY: "off" } }), undefined);
	assert.equal(resolvePostHogTelemetryConfig({ env: { DO_NOT_TRACK: "1" } }), undefined);
});

test("first-run notice describes the opt-in, once per Hypatia home", withTelemetryOptInEnv(async () => {
	const home = mkdtempSync(join(tmpdir(), "hypatia-telemetry-notice-home-"));
	try {
		assert.match(TELEMETRY_NOTICE, /off by default/);
		assert.match(TELEMETRY_NOTICE, /never sends prompts, model output, paper content, or tool arguments/);
		assert.match(TELEMETRY_NOTICE, /HYPATIA_TELEMETRY=1/);

		initializePostHogTelemetry({ home, posthogFetch: async () => new Response(null, { status: 204 }) });
		// Scripts and CI never see it, and it stays pending for the first interactive run.
		assert.equal(telemetryFirstRunNotice(home, false), undefined);
		assert.equal(telemetryFirstRunNotice(home, true), TELEMETRY_NOTICE);
		// Repeats within the process so a launch that clears the screen can reprint it.
		assert.equal(telemetryFirstRunNotice(home, true), TELEMETRY_NOTICE);
		const state = JSON.parse(readFileSync(join(home, ".state", "telemetry.json"), "utf8")) as { noticeShown?: boolean; anonymousId?: string };
		assert.equal(state.noticeShown, true);
		assert.match(state.anonymousId ?? "", /^hypatia_/);
		await shutdownPostHogTelemetry();

		initializePostHogTelemetry({ home, posthogFetch: async () => new Response(null, { status: 204 }) });
		assert.equal(telemetryFirstRunNotice(home, true), undefined);
		await shutdownPostHogTelemetry();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}));

test("Pi child env carries the CLI's PostHog project and install id only while opted in", withTelemetryOptInEnv(async () => {
	const home = mkdtempSync(join(tmpdir(), "hypatia-telemetry-child-env-"));
	try {
		const config = initializePostHogTelemetry({ home, posthogFetch: async () => new Response(null, { status: 204 }) });
		assert.deepEqual(getPostHogChildEnv(), {
			HYPATIA_POSTHOG_KEY: TEST_POSTHOG_KEY,
			HYPATIA_POSTHOG_HOST: DEFAULT_POSTHOG_HOST,
			HYPATIA_TELEMETRY_DISTINCT_ID: config?.distinctId,
		});
		await shutdownPostHogTelemetry();
		assert.deepEqual(getPostHogChildEnv(), {});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}));

test("PostHog transport failures open a silent session circuit breaker", withTelemetryOptInEnv(async () => {
	const home = mkdtempSync(join(tmpdir(), "hypatia-telemetry-failure-home-"));
	let fetchAttempts = 0;
	const originalConsoleError = console.error;
	const consoleErrors: unknown[][] = [];
	console.error = (...args: unknown[]) => {
		consoleErrors.push(args);
	};

	try {
		initializePostHogTelemetry({
			home,
			appVersion: "0.3.10",
			posthogFetch: async () => {
				fetchAttempts += 1;
				throw new Error("simulated unreachable telemetry endpoint");
			},
		});
		await captureTelemetryEventImmediate("transport_failure_probe");
		await captureTelemetryEventImmediate("transport_failure_probe_after_circuit");
		await shutdownPostHogTelemetry();
	} finally {
		console.error = originalConsoleError;
		await shutdownPostHogTelemetry();
	}

	assert.equal(fetchAttempts, 1);
	assert.deepEqual(consoleErrors, []);
}));

test("PostHog transport sends gzip bytes without retaining Node Blob readers", withTelemetryOptInEnv(async () => {
	const home = mkdtempSync(join(tmpdir(), "hypatia-telemetry-gzip-home-"));
	let requestBody: unknown;
	let requestHeaders: unknown;
	try {
		initializePostHogTelemetry({
			home,
			appVersion: "0.3.39",
			posthogFetch: async (_url, options) => {
				requestBody = options?.body;
				requestHeaders = options?.headers;
				return new Response(null, { status: 204 });
			},
		});
		await captureTelemetryEventImmediate("gzip_body_probe");
	} finally {
		await shutdownPostHogTelemetry();
		rmSync(home, { recursive: true, force: true });
	}

	assert.equal(requestBody instanceof Uint8Array, true);
	assert.equal(requestBody instanceof Blob, false);
	assert.deepEqual(Array.from((requestBody as Uint8Array).subarray(0, 2)), [0x1f, 0x8b]);
	assert.equal(new Headers(requestHeaders as HeadersInit).get("content-encoding"), "gzip");
	assert.match(gunzipSync(requestBody as Uint8Array).toString("utf8"), /gzip_body_probe/);
}));

test("PostHog circuit breaker drops later requests after a non-success response", async () => {
	let fetchAttempts = 0;
	const failures: unknown[] = [];
	const circuitFetch = createTelemetryCircuitBreakerFetch(
		async () => {
			fetchAttempts += 1;
			return new Response("unavailable", { status: 503 });
		},
		(error) => failures.push(error),
	);

	const request = { method: "POST" as const, headers: {} };
	assert.equal((await circuitFetch("https://example.test/batch", request)).status, 204);
	assert.equal((await circuitFetch("https://example.test/batch", request)).status, 204);
	assert.equal(fetchAttempts, 1);
	assert.equal(failures.length, 1);
	assert.match(failures[0] instanceof Error ? failures[0].message : "", /HTTP 503/);
});

test("getCliTelemetryMetadata does not record unknown commands or malformed flag values", () => {
	const metadata = getCliTelemetryMetadata([
		"private-research-prompt",
		"--mode",
		"/private/path/mode",
		"--service-tier=not-a-number",
	]);
	const serialized = JSON.stringify(metadata);

	assert.equal(metadata.command, "chat");
	assert.equal(metadata.mode, undefined);
	assert.equal(serialized.includes("private-research-prompt"), false);
	assert.equal(serialized.includes("/private/path"), false);
	assert.equal(serialized.includes("not-a-number"), false);
});

test("getCliTelemetryMetadata keeps whitelisted workflow commands and safe subcommands", () => {
	const workflow = getCliTelemetryMetadata(["review", "paper title"], { knownCommands: ["review"] });
	const unknownSubcommand = getCliTelemetryMetadata(["model", "private-provider-name"]);
	const knownSubcommand = getCliTelemetryMetadata(["model", "list"]);

	assert.equal(workflow.command, "review");
	assert.equal(unknownSubcommand.command, "model");
	assert.equal(unknownSubcommand.subcommand, undefined);
	assert.equal(knownSubcommand.command, "model");
	assert.equal(knownSubcommand.subcommand, "list");
});

test("getCliTelemetryMetadata does not treat double-dash prompt text as a command", () => {
	const metadata = getCliTelemetryMetadata([
		"--",
		"private",
		"one-shot",
		"prompt",
	]);
	const serialized = JSON.stringify(metadata);

	assert.equal(metadata.command, "chat");
	assert.equal(serialized.includes("private"), false);
	assert.equal(serialized.includes("one-shot"), false);
});

test("telemetryErrorProperties falls back when Error.name is not a safe class label", () => {
	const error = new Error("stable message");
	error.name = "Private /Users/advaitpaliwal/Error";

	assert.equal(telemetryErrorProperties(error).error_name, "Error");
});

test("normalizeTelemetryProperties keeps bounded snake_case scalar properties", () => {
	const normalized = normalizeTelemetryProperties({
		"Command Name": "rank",
		durationMs: 123,
		raw: "x".repeat(300),
		empty: "",
		notFinite: Number.POSITIVE_INFINITY,
	});

	assert.deepEqual(Object.keys(normalized).sort(), ["command_name", "duration_ms", "raw"]);
	assert.equal(normalized.command_name, "rank");
	assert.equal(normalized.duration_ms, 123);
	assert.equal(String(normalized.raw).length, 240);
});

test("error text is sent raw with the home folder shown as ~", () => {
	const home = "/Users/someone";
	assert.equal(redactTelemetryText(`ENOENT: open '${home}/proj/outputs/x.md'`, home), "ENOENT: open '~/proj/outputs/x.md'");
	assert.equal(redactTelemetryText("C:\\Users\\someone\\a and C:/Users/someone/b", "C:\\Users\\someone"), "~\\a and ~/b");
	assert.equal(redactTelemetryText("x".repeat(5000), home).length, 4003);
	assert.equal(telemetryErrorProperties(new Error("Unknown model: openai/gpt-9")).error_message, "Unknown model: openai/gpt-9");
	const stderr = "line one\n  at frame (file.js:1:2)\n";
	assert.equal(normalizeTelemetryProperties({ pi_stderr: stderr }).pi_stderr, stderr.trim());
});

test("captureTelemetryException sends a redacted stack trace to PostHog error tracking", withTelemetryOptInEnv(async () => {
	const home = mkdtempSync(join(tmpdir(), "hypatia-telemetry-exception-home-"));
	const bodies: string[] = [];
	try {
		initializePostHogTelemetry({
			home,
			posthogFetch: async (_url, options) => {
				bodies.push(gunzipSync(options?.body as Uint8Array).toString("utf8"));
				return new Response(null, { status: 204 });
			},
		});
		const error = new TypeError(`boom in ${homedir()}/project`);
		error.stack = `TypeError: boom in ${homedir()}/project\n    at run (${homedir()}/app/cli.js:10:5)`;
		await captureTelemetryException(error, { command: "chat" });
		await shutdownPostHogTelemetry();
	} finally {
		await shutdownPostHogTelemetry();
		rmSync(home, { recursive: true, force: true });
	}
	const sent = bodies.join("\n");
	assert.match(sent, /\$exception/);
	assert.match(sent, /boom in ~\/project/);
	assert.match(sent, /cli\.js/);
	assert.equal(sent.includes(homedir()), false);
}));

test("a telemetry send that gets no answer ends quietly within its budget", async () => {
	const failures: unknown[] = [];
	const hangingFetch = ((_url: string, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
		options?.signal?.addEventListener("abort", () => reject(options.signal!.reason));
	})) as never;
	const send = createTelemetryCircuitBreakerFetch(hangingFetch, (error) => failures.push(error), 200);
	const started = Date.now();
	const response = await send("https://posthog.test/batch/", { method: "POST", headers: {} } as never);
	assert.equal(response.status, 204);
	assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
	assert.equal(failures.length, 1);
});
