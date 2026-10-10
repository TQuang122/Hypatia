import assert from "node:assert/strict";
import test from "node:test";
import {
	currentEnvironmentFingerprintHost,
	fingerprintEnvironment,
	type EnvironmentFingerprintHost,
} from "../src/experiments/environment.js";

const contract = {
	environment: "venv; image=ghcr.io/example/runner@sha256:deadbeef",
	executableHash: "a".repeat(64),
	inputHashes: { "uv.lock": "b".repeat(64) },
};

const host: EnvironmentFingerprintHost = {
	platform: "darwin",
	architecture: "arm64",
	runtimeVersion: "v24.0.0",
};

test("environment fingerprint is stable and binds the declared execution inputs", () => {
	const fingerprint = fingerprintEnvironment(contract, host);

	assert.deepEqual(fingerprint, fingerprintEnvironment(contract, host));
	assert.match(fingerprint.sha256, /^[a-f0-9]{64}$/);
	assert.notEqual(
		fingerprint.sha256,
		fingerprintEnvironment({ ...contract, environment: "different environment" }, host).sha256,
	);
	assert.notEqual(
		fingerprint.sha256,
		fingerprintEnvironment({ ...contract, executableHash: "c".repeat(64) }, host).sha256,
	);
	assert.notEqual(
		fingerprint.sha256,
		fingerprintEnvironment({ ...contract, inputHashes: { "uv.lock": "d".repeat(64) } }, host).sha256,
	);
	assert.notEqual(
		fingerprint.sha256,
		fingerprintEnvironment(contract, { ...host, architecture: "x64" }).sha256,
	);
});

test("environment fingerprint excludes inherited environment variable values", (t) => {
	const key = "HYPATIA_TEST_ENV_FINGERPRINT_SECRET";
	const previous = process.env[key];
	t.after(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});

	process.env[key] = "first-secret-value";
	const first = fingerprintEnvironment(contract, currentEnvironmentFingerprintHost());
	process.env[key] = "second-secret-value";
	const second = fingerprintEnvironment(contract, currentEnvironmentFingerprintHost());

	assert.deepEqual(second, first);
	assert.equal(JSON.stringify(first).includes("first-secret-value"), false);
	assert.equal(JSON.stringify(first).includes("second-secret-value"), false);
});
