import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
	copyModelRoutesToAgentDir,
	loadModelRoutesFile,
	resolveModelRoutesSource,
} from "../evals/model-routes.mjs";

test("resolveModelRoutesSource defaults to the route file under HYPATIA_HOME when present", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-eval-route-home-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, ".hypatia", "agent", "model-routes.json");
	mkdirSync(join(root, ".hypatia", "agent"), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: 1, roles: {} }));

	assert.deepEqual(resolveModelRoutesSource({ hypatiaHome: root, homeDirectory: "/home/test" }), {
		source: "user-default",
		path,
	});
});

test("resolveModelRoutesSource leaves routes unset when the default config is absent", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-eval-route-none-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	assert.deepEqual(resolveModelRoutesSource({ hypatiaHome: root, homeDirectory: "/home/test" }), { source: "none" });
});

test("resolveModelRoutesSource supports explicit and disabled route selection", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-eval-route-override-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const explicit = join(root, "selected-routes.json");
	writeFileSync(explicit, JSON.stringify({ version: 1, roles: {} }));

	assert.deepEqual(resolveModelRoutesSource({ explicitPath: explicit, hypatiaHome: root }), {
		source: "explicit",
		path: explicit,
	});
	const disabled = resolveModelRoutesSource({ disabled: true, hypatiaHome: root });
	assert.deepEqual(disabled, { source: "disabled" });
	assert.deepEqual(loadModelRoutesFile(disabled), { source: "disabled", config: null, contents: null });
	assert.throws(
		() => resolveModelRoutesSource({ explicitPath: explicit, disabled: true, hypatiaHome: root }),
		/--model-routes-json cannot be combined with --no-model-routes/,
	);
});

test("resolveModelRoutesSource expands home-relative HYPATIA_HOME", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-eval-route-tilde-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "project", ".hypatia", "agent", "model-routes.json");
	mkdirSync(join(root, "project", ".hypatia", "agent"), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: 1, roles: {} }));

	assert.deepEqual(
		resolveModelRoutesSource({ hypatiaHome: "~/project", homeDirectory: root }),
		{ source: "user-default", path },
	);
});

test("loadModelRoutesFile and copyModelRoutesToAgentDir reproduce routes in the isolated agent home", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-eval-route-copy-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sourcePath = join(root, "source", "model-routes.json");
	const isolatedAgentDir = join(root, "eval", "home", ".hypatia", "agent");
	const contents = JSON.stringify({
		version: 1,
		roles: { "evidence-scout": ["openai-codex/gpt-5.6-luna", "anthropic/claude-sonnet-5-5"] },
	}, null, 2) + "\n";
	mkdirSync(join(root, "source"), { recursive: true });
	writeFileSync(sourcePath, contents);

	const loaded = loadModelRoutesFile({ source: "explicit", path: sourcePath });
	const copied = copyModelRoutesToAgentDir(loaded, isolatedAgentDir);

	assert.deepEqual(loaded.config, {
		version: 1,
		roles: { "evidence-scout": ["openai-codex/gpt-5.6-luna", "anthropic/claude-sonnet-5-5"] },
	});
	assert.equal(copied, join(isolatedAgentDir, "model-routes.json"));
	assert.ok(copied);
	assert.equal(readFileSync(copied, "utf8"), contents);
});

test("loadModelRoutesFile rejects invalid JSON before an eval starts", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-eval-route-invalid-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "model-routes.json");
	writeFileSync(path, "{");

	assert.throws(() => loadModelRoutesFile({ source: "explicit", path }), /Invalid model routes/);
});

test("eval runner copies the selected model routes into each isolated Hypatia home", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-eval-runner-routes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fakeHypatia = join(root, "fake-hypatia.mjs");
	const routesPath = join(root, "model-routes.json");
	const workRoot = join(root, "work");
	const resultsDir = join(root, "results");
	const routes = {
		version: 1,
		roles: { "evidence-scout": ["openai-codex/gpt-5.6-luna", "anthropic/claude-sonnet-5-5"] },
	};
	writeFileSync(routesPath, JSON.stringify(routes));
	writeFileSync(fakeHypatia, `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const routePath = join(process.env.HYPATIA_HOME, ".hypatia", "agent", "model-routes.json");
const routes = JSON.parse(readFileSync(routePath, "utf8"));
mkdirSync("outputs", { recursive: true });
writeFileSync("outputs/eval-fixture.md", JSON.stringify(routes));
writeFileSync("outputs/eval-fixture.provenance.md", "# Provenance");
	`);

	execFileSync(process.execPath, [
		resolve("evals/run.mjs"),
		"--model", "fixture/test-model",
		"--ids", "q01",
		"--hypatia", fakeHypatia,
		"--work-root", workRoot,
		"--results-dir", resultsDir,
		"--model-routes-json", routesPath,
	], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { ...process.env, HYPATIA_TELEMETRY: "0" } });

	const jsonl = readdirSync(resultsDir).find((file) => file.endsWith(".jsonl"));
	assert.ok(jsonl);
	const row = JSON.parse(readFileSync(join(resultsDir, jsonl), "utf8").trim());
	assert.equal(row.model_routes_source, "explicit");
	assert.deepEqual(row.model_routes, routes);
	assert.deepEqual(JSON.parse(readFileSync(join(row.workdir, "home", ".hypatia", "agent", "model-routes.json"), "utf8")), routes);
});

test("eval runner copies OAuth only while the isolated run is active", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-eval-runner-auth-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fakeHypatia = join(root, "fake-hypatia.mjs");
	const authPath = join(root, "auth.json");
	const workRoot = join(root, "work");
	const resultsDir = join(root, "results");
	const authContents = JSON.stringify({ "fixture-provider": { type: "oauth", access: "secret-fixture-token" } });
	writeFileSync(authPath, authContents);
	writeFileSync(fakeHypatia, `
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const authPath = join(process.env.HYPATIA_HOME, ".hypatia", "agent", "auth.json");
const auth = JSON.parse(readFileSync(authPath, "utf8"));
const mode = statSync(authPath).mode & 0o777;
mkdirSync("outputs", { recursive: true });
writeFileSync("outputs/eval-fixture.md", JSON.stringify({ authenticated: Boolean(auth["fixture-provider"]), mode, tokenAbsentFromWorkspace: !existsSync(join(process.cwd(), "auth.json")) }));
writeFileSync("outputs/eval-fixture.provenance.md", "# Provenance");
	`);

	execFileSync(process.execPath, [
		resolve("evals/run.mjs"),
		"--model", "fixture/test-model",
		"--ids", "q01",
		"--hypatia", fakeHypatia,
		"--work-root", workRoot,
		"--results-dir", resultsDir,
		"--auth-json", authPath,
	], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { ...process.env, HYPATIA_TELEMETRY: "0" } });

	const jsonl = readdirSync(resultsDir).find((file) => file.endsWith(".jsonl"));
	assert.ok(jsonl);
	const row = JSON.parse(readFileSync(join(resultsDir, jsonl), "utf8").trim());
	const output = JSON.parse(readFileSync(join(row.workdir, "ws", "outputs", "eval-fixture.md"), "utf8"));
	const isolatedAuthPath = join(row.workdir, "home", ".hypatia", "agent", "auth.json");
	assert.equal(output.authenticated, true);
	assert.equal(output.mode, 0o600);
	assert.equal(output.tokenAbsentFromWorkspace, true);
	assert.equal(existsSync(isolatedAuthPath), false);
	assert.equal(readFileSync(authPath, "utf8"), authContents);
});

test("eval runner accepts local workflow question manifests and scores audit artifacts without provenance", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-eval-runner-audit-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fakeHypatia = join(root, "fake-hypatia.mjs");
	const questionsPath = join(root, "audit-questions.jsonl");
	const workRoot = join(root, "work");
	const resultsDir = join(root, "results");
	writeFileSync(questionsPath, JSON.stringify({
		id: "audit-case-01",
		question: "paper URL and repository URL",
	}) + "\n");
	writeFileSync(fakeHypatia, `
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("outputs", { recursive: true });
writeFileSync("outputs/audit-case-01-audit.md", "# Audit findings");
	`);

	execFileSync(process.execPath, [
		resolve("evals/run.mjs"),
		"--model", "fixture/test-model",
		"--workflow", "audit",
		"--questions-jsonl", questionsPath,
		"--hypatia", fakeHypatia,
		"--work-root", workRoot,
		"--results-dir", resultsDir,
	], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { ...process.env, HYPATIA_TELEMETRY: "0" } });

	const jsonl = readdirSync(resultsDir).find((file) => file.endsWith(".jsonl"));
	assert.ok(jsonl);
	const row = JSON.parse(readFileSync(join(resultsDir, jsonl), "utf8").trim());
	assert.equal(row.workflow, "audit");
	assert.equal(row.id, "audit-case-01");
	assert.equal(row.completed, true);
	assert.equal(row.final_output, "outputs/audit-case-01-audit.md");
	assert.equal(row.key_recall, null);
});
