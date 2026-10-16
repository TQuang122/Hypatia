import assert from "node:assert/strict";
import test from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { selectIdeaModelPanel } from "../extensions/research-tools/idea-model-selector.js";

test("Idea Forge model selector wheel moves its highlight and selects the active model", async () => {
	const createDescriptor = Object.getOwnPropertyDescriptor(ModelRuntime, "create");
	const models = ["alpha", "beta", "gamma"].map((id) => ({ provider: "test", id }));
	const fakeTui = { terminal: { rows: 40 }, requestRender() {} };
	const fakeTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		style: (text: string) => text,
		colors: { customMessageBg: "", selectedBg: "" },
	};
	const wheel: TuiMouseEvent = {
		type: "wheel", button: "none", x: 10, y: 5, screenX: 10, screenY: 5,
		width: 80, height: 24, shift: false, alt: false, ctrl: false, wheelDelta: 1,
	};

	Object.defineProperty(ModelRuntime, "create", {
		configurable: true,
		writable: true,
		value: async () => ({ getAvailable: async () => models }),
	});
	try {
		const selected = await selectIdeaModelPanel({
			mode: "tui",
			model: { provider: "test", id: "alpha" },
			scopedModels: [],
			signal: new AbortController().signal,
			ui: {
				custom: async (factory: any, overlay: any) =>
					new Promise<string[] | undefined>((resolve) => {
						assert.deepEqual(overlay, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "58%", offsetY: -6, margin: 0 } });
						const panel = factory(fakeTui, fakeTheme, {}, resolve);
						assert.match(panel.render(80).join("\n"), /› \[x\] test\/alpha/u);
						assert.deepEqual(panel.handleMouse(wheel), { handled: true, render: true });
						assert.match(panel.render(80).join("\n"), /› \[ \] test\/beta/u);
						panel.handleInput(" ");
						panel.handleInput("\r");
					}),
			},
		} as any);
		assert.deepEqual(selected, ["test/beta"]);
	} finally {
		if (createDescriptor) Object.defineProperty(ModelRuntime, "create", createDescriptor);
	}
});
