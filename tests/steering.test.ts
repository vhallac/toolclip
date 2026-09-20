import { describe, expect, it } from "vitest";
import {
	buildSteeringMessage,
	createSteeringState,
	observePendingBand,
	resetSteering,
	unreplacedPendingIds,
} from "../lib/steering.ts";
import { createRuntimeState, recordPending, recordReplacement } from "../lib/runtime-state.js";

const LONG = "x".repeat(2000); // 500 tokens

describe("createSteeringState", () => {
	it("starts with band 0 (nothing announced)", () => {
		const s = createSteeringState();
		expect(s.announcedBand).toBe(0);
	});
});

describe("resetSteering", () => {
	it("resets the band to 0 in place", () => {
		const s = createSteeringState();
		s.announcedBand = 3;
		resetSteering(s);
		expect(s.announcedBand).toBe(0);
		// mutates the same object (no re-allocation)
		expect(s).toBe(s);
	});
});

describe("unreplacedPendingIds", () => {
	it("collects pending entries that have no replacement", () => {
		const rt = createRuntimeState();
		recordPending(rt, "a", 100, LONG);
		recordPending(rt, "b", 100, LONG);
		expect(unreplacedPendingIds(rt).sort()).toEqual(["a", "b"]);
	});

	it("excludes replaced entries", () => {
		const rt = createRuntimeState();
		recordPending(rt, "a", 100, LONG);
		recordPending(rt, "b", 100, LONG);
		recordReplacement(rt, "a", "short", 1);
		expect(unreplacedPendingIds(rt)).toEqual(["b"]);
	});

	it("is empty when empty", () => {
		expect(unreplacedPendingIds(createRuntimeState())).toEqual([]);
	});
});

describe("observePendingBand", () => {
	it("does not fire when disabled via config", () => {
		const s = createSteeringState();
		expect(observePendingBand(s, 7, 5, false)).toBe(false);
		expect(s.announcedBand).toBe(0); // band not tracked while disabled
	});

	it("does not fire below the first multiple", () => {
		const s = createSteeringState();
		expect(observePendingBand(s, 1, 5, true)).toBe(false);
		expect(observePendingBand(s, 4, 5, true)).toBe(false);
	});

	it("fires when the count first reaches the band size", () => {
		const s = createSteeringState();
		expect(observePendingBand(s, 5, 5, true)).toBe(true);
		expect(s.announcedBand).toBe(1);
	});

	it("fires once per band, then again at the next multiple", () => {
		const s = createSteeringState();
		expect(observePendingBand(s, 7, 5, true)).toBe(true); // 5-9 band entered
		expect(observePendingBand(s, 8, 5, true)).toBe(false);
		expect(observePendingBand(s, 9, 5, true)).toBe(false);
		expect(observePendingBand(s, 12, 5, true)).toBe(true); // 10-14 band entered
		expect(observePendingBand(s, 14, 5, true)).toBe(false);
	});

	it("fires once for a jump across several bands (announces the current band)", () => {
		const s = createSteeringState();
		expect(observePendingBand(s, 13, 5, true)).toBe(true); // 0 -> band 2, one fire
		expect(s.announcedBand).toBe(2);
		expect(observePendingBand(s, 13, 5, true)).toBe(false);
	});

	it("re-arms when the count drops below the announced band", () => {
		const s = createSteeringState();
		observePendingBand(s, 6, 5, true); // band 1 announced
		expect(observePendingBand(s, 3, 5, true)).toBe(false); // drop: band follows to 0
		expect(s.announcedBand).toBe(0);
		expect(observePendingBand(s, 5, 5, true)).toBe(true); // re-grown pile nagged again
		expect(observePendingBand(s, 6, 5, true)).toBe(false);
	});

	it("does not re-fire while the count stays inside the announced band after a partial drop", () => {
		const s = createSteeringState();
		observePendingBand(s, 12, 5, true); // band 2 announced
		observePendingBand(s, 7, 5, true); // drop into band 1: follows down silently
		expect(s.announcedBand).toBe(1);
		expect(observePendingBand(s, 9, 5, true)).toBe(false); // same band
		expect(observePendingBand(s, 10, 5, true)).toBe(true); // next band
	});

	it("respects a custom multiple", () => {
		const s = createSteeringState();
		expect(observePendingBand(s, 2, 3, true)).toBe(false);
		expect(observePendingBand(s, 3, 3, true)).toBe(true);
		expect(observePendingBand(s, 5, 3, true)).toBe(false);
		expect(observePendingBand(s, 6, 3, true)).toBe(true);
	});
});

describe("buildSteeringMessage", () => {
	it("mentions the count, the anti-hoarding rule, and the replace tool", () => {
		const msg = buildSteeringMessage(3, ["a", "b", "c"]);
		expect(msg).toContain("3 tool-result-pending-replacements");
		expect(msg).toContain("replace_tool_result");
		expect(msg).toContain("just in case");
	});

	it("lists each pending id on its own line", () => {
		const msg = buildSteeringMessage(2, ["id-1", "id-2"]);
		expect(msg).toContain("- id-1");
		expect(msg).toContain("- id-2");
		expect(msg.indexOf("- id-1")).toBeLessThan(msg.indexOf("- id-2"));
	});

	it("ends with the id list", () => {
		const msg = buildSteeringMessage(1, ["solo"]);
		expect(msg.trimEnd().endsWith("- solo")).toBe(true);
	});
});