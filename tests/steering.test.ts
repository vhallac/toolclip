import { describe, expect, it } from "vitest";
import {
	buildSteeringMessage,
	createSteeringState,
	observePendingSteering,
	pendingSummary,
	resetSteering,
	unreplacedPendingIds,
} from "../lib/steering.ts";
import type { SteeringOptions } from "../lib/steering.ts";
import { createRuntimeState, recordPending, recordReplacement } from "../lib/runtime-state.js";

const LONG = "x".repeat(2000); // filler content; token counts are passed explicitly

const OPTS: SteeringOptions = { countThreshold: 5, sizeThresholdTokens: 5000, enabled: true };
const DISABLED: SteeringOptions = { ...OPTS, enabled: false };

describe("createSteeringState", () => {
	it("starts with both latches unset", () => {
		const s = createSteeringState();
		expect(s.countLatched).toBe(false);
		expect(s.sizeLatched).toBe(false);
	});
});

describe("resetSteering", () => {
	it("resets both latches in place", () => {
		const s = createSteeringState();
		s.countLatched = true;
		s.sizeLatched = true;
		resetSteering(s);
		expect(s.countLatched).toBe(false);
		expect(s.sizeLatched).toBe(false);
		// mutates the same object (no re-allocation)
		expect(s).toBe(s);
	});
});

describe("pendingSummary", () => {
	it("collects pending entries with their token counts and the total", () => {
		const rt = createRuntimeState();
		recordPending(rt, "a", 100, LONG);
		recordPending(rt, "b", 250, LONG);
		const summary = pendingSummary(rt);
		expect(summary.items).toEqual([
			{ id: "a", tokens: 100 },
			{ id: "b", tokens: 250 },
		]);
		expect(summary.totalTokens).toBe(350);
	});

	it("excludes replaced entries", () => {
		const rt = createRuntimeState();
		recordPending(rt, "a", 100, LONG);
		recordPending(rt, "b", 250, LONG);
		recordReplacement(rt, "a", "short", 1);
		const summary = pendingSummary(rt);
		expect(summary.items).toEqual([{ id: "b", tokens: 250 }]);
		expect(summary.totalTokens).toBe(250);
	});

	it("is empty when empty", () => {
		expect(pendingSummary(createRuntimeState())).toEqual({ items: [], totalTokens: 0 });
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

describe("observePendingSteering — count trigger", () => {
	it("does not fire when disabled, and does not track latches", () => {
		const s = createSteeringState();
		expect(observePendingSteering(s, 7, 9000, DISABLED)).toEqual({ count: false, size: false });
		expect(s.countLatched).toBe(false);
		expect(s.sizeLatched).toBe(false);
	});

	it("does not fire at or below the count threshold (strictly greater)", () => {
		const s = createSteeringState();
		expect(observePendingSteering(s, 1, 0, OPTS).count).toBe(false);
		expect(observePendingSteering(s, 5, 0, OPTS).count).toBe(false);
		expect(s.countLatched).toBe(false);
	});

	it("fires once when the count exceeds the threshold, then stays latched", () => {
		const s = createSteeringState();
		expect(observePendingSteering(s, 6, 0, OPTS).count).toBe(true);
		expect(s.countLatched).toBe(true);
		expect(observePendingSteering(s, 7, 0, OPTS).count).toBe(false);
		expect(observePendingSteering(s, 9, 0, OPTS).count).toBe(false);
		expect(observePendingSteering(s, 20, 0, OPTS).count).toBe(false);
	});

	it("re-arms when the count falls back to the threshold, and fires again on re-growth", () => {
		const s = createSteeringState();
		observePendingSteering(s, 6, 0, OPTS); // fires, latches
		expect(observePendingSteering(s, 5, 0, OPTS).count).toBe(false); // re-arm at the threshold
		expect(s.countLatched).toBe(false);
		expect(observePendingSteering(s, 6, 0, OPTS).count).toBe(true); // re-grown pile nagged again
	});

	it("respects a custom count threshold", () => {
		const s = createSteeringState();
		const opts: SteeringOptions = { ...OPTS, countThreshold: 3 };
		expect(observePendingSteering(s, 3, 0, opts).count).toBe(false);
		expect(observePendingSteering(s, 4, 0, opts).count).toBe(true);
		expect(observePendingSteering(s, 6, 0, opts).count).toBe(false);
	});
});

describe("observePendingSteering — size trigger", () => {
	it("does not fire at or below the size threshold (strictly greater)", () => {
		const s = createSteeringState();
		expect(observePendingSteering(s, 1, 4000, OPTS).size).toBe(false);
		expect(observePendingSteering(s, 1, 5000, OPTS).size).toBe(false);
		expect(s.sizeLatched).toBe(false);
	});

	it("fires once when the total exceeds the size threshold, even with a count of 1", () => {
		// The 2026-09-20 golden-run case: one huge un-replaced result never
		// exceeds a count of 5 — the size trigger must catch it.
		const s = createSteeringState();
		const t = observePendingSteering(s, 1, 30000, OPTS);
		expect(t.size).toBe(true);
		expect(t.count).toBe(false);
		expect(s.sizeLatched).toBe(true);
		expect(observePendingSteering(s, 1, 30000, OPTS).size).toBe(false); // latched
	});

	it("re-arms when the total falls back to the threshold, and fires again on re-growth", () => {
		const s = createSteeringState();
		observePendingSteering(s, 1, 6000, OPTS); // fires, latches
		expect(observePendingSteering(s, 1, 5000, OPTS).size).toBe(false); // re-arm at the threshold
		expect(s.sizeLatched).toBe(false);
		expect(observePendingSteering(s, 1, 6000, OPTS).size).toBe(true);
	});
});

describe("observePendingSteering — independent latches", () => {
	it("both triggers can fire on the same observation", () => {
		const s = createSteeringState();
		const t = observePendingSteering(s, 7, 9000, OPTS);
		expect(t.count).toBe(true);
		expect(t.size).toBe(true);
		expect(s.countLatched).toBe(true);
		expect(s.sizeLatched).toBe(true);
	});

	it("a count fire does not latch the size trigger (and vice versa)", () => {
		// Count fires first with a small pile (below the size threshold).
		const s = createSteeringState();
		expect(observePendingSteering(s, 7, 3000, OPTS)).toEqual({ count: true, size: false });
		// The pile is distilled down to one huge item: count re-arms, and the
		// size trigger — never latched — still catches it.
		const t = observePendingSteering(s, 1, 6000, OPTS);
		expect(t.count).toBe(false);
		expect(t.size).toBe(true);
	});

	it("a size fire does not latch the count trigger", () => {
		// One huge item: size fires and latches, count is below its threshold.
		const s = createSteeringState();
		expect(observePendingSteering(s, 1, 6000, OPTS)).toEqual({ count: false, size: true });
		// The pile re-grows by count while staying above the size threshold:
		// the count trigger fires even though the size latch is held.
		const t = observePendingSteering(s, 6, 6500, OPTS);
		expect(t.count).toBe(true);
		expect(t.size).toBe(false);
	});
});

describe("buildSteeringMessage", () => {
	it("mentions the count, the total, the anti-hoarding rule, and the replace tool", () => {
		const msg = buildSteeringMessage(
			3,
			4200,
			[
				{ id: "a", tokens: 3000 },
				{ id: "b", tokens: 1000 },
				{ id: "c", tokens: 200 },
			],
		);
		expect(msg).toContain("3 tool-result-pending-replacements");
		expect(msg).toContain("~4200 estimated tokens");
		expect(msg).toContain("replace_tool_result");
		expect(msg).toContain("just in case");
	});

	it("lists each pending id with its size on its own line", () => {
		const msg = buildSteeringMessage(2, 1100, [
			{ id: "id-1", tokens: 1000 },
			{ id: "id-2", tokens: 100 },
		]);
		expect(msg).toContain("- id-1 (~1000 tokens)");
		expect(msg).toContain("- id-2 (~100 tokens)");
		expect(msg.indexOf("- id-1")).toBeLessThan(msg.indexOf("- id-2"));
	});

	it("ends with the id list", () => {
		const msg = buildSteeringMessage(1, 30000, [{ id: "solo", tokens: 30000 }]);
		expect(msg.trimEnd().endsWith("- solo (~30000 tokens)")).toBe(true);
	});
});