import assert from "node:assert/strict";
import test from "node:test";

import { runSetup } from "../src/setup/setup.js";

test("runSetup stops before optional onboarding when model setup is cancelled", async () => {
	let modelSetupCalled = false;
	await runSetup({
		settingsPath: "/tmp/hypatia-setup-test/settings.json",
		bundledSettingsPath: "/tmp/hypatia-setup-test/bundled-settings.json",
		authPath: "/tmp/hypatia-setup-test/auth.json",
		workingDir: "/tmp/hypatia-setup-test/workspace",
		sessionDir: "/tmp/hypatia-setup-test/sessions",
		appRoot: process.cwd(),
	}, {
		isInteractiveTerminal: () => true,
		promptIntro: async () => undefined,
		runModelSetup: async () => {
			modelSetupCalled = true;
			return false;
		},
	});
	assert.equal(modelSetupCalled, true);
});
