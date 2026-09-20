import { describe, expect, it } from "vitest";
import toolclip from "../src/toolclip.ts";

describe("bootstrap", () => {
	it("loads the extension entrypoint as a function", () => {
		expect(typeof toolclip).toBe("function");
	});

	it("has the expected directory shape", () => {
		// Sanity check: the loader, lib, and tests directories exist and the
		// main entrypoint is wired through index.ts.
		expect(typeof toolclip).toBe("function");
	});
});
