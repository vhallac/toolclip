import { describe, expect, it } from "vitest";
import { loadToolclipConfig } from "../lib/toolclip-config.ts";

describe("loadToolclipConfig", () => {
	it("returns an empty config (no size thresholds) by default", () => {
		expect(loadToolclipConfig({} as NodeJS.ProcessEnv)).toEqual({});
	});

	it("ignores legacy size-threshold env vars", () => {
		// Thresholds were removed so replacement behavior can be observed
		// without pre-filtering or gating. Legacy env vars are ignored.
		const config = loadToolclipConfig({
			TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS: "500",
			TOOLCLIP_MAX_REPLACEMENT_RATIO: "0.25",
		} as NodeJS.ProcessEnv);

		expect(config).toEqual({});
	});

	it("returns an empty config regardless of env input", () => {
		expect(loadToolclipConfig(process.env)).toEqual({});
	});
});
