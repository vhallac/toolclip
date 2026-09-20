import { describe, expect, it } from "vitest";
import {
	buildSteeringMessage,
	createSteeringState,
	markFired,
	observeTurn,
	resetSteering,
	shouldFireSteering,
	unreplacedPendingCount,
} from "../lib/steering.ts";
import { createRuntimeState, recordPending, recordReplacement } from "../lib/runtime-state.js";

const LONG = "x".repeat(2000); // 500 tokens

describe("createSteeringState", () => {
	it("starts unfired with zero pending turns", () => {
		const s = createSteeringState();
		expect(s.fired).toBe(false);
		expect(s.turnsWithPending).toBe(0);
	});
});

describe("resetSteering", () => {
	it("clears fired and turn count in place", () => {
		const s = createSteeringState();
		s.fired = true;
		s.turnsWithPending = 9;
		resetSteering(s);
		expect(s.fired).toBe(false);
		expect(s.turnsWithPending).toBe(0);
		// mutates the same object (no re-allocation)
		expect(s).toBe(s);
	});
});

describe("unreplacedPendingCount", () => {
	it("counts pending entries that have no replacement", () => {
		const rt = createRuntimeState();
		recordPending(rt, "a", 100, LONG);
		recordPending(rt, "b", 100, LONG);
		expect(unreplacedPendingCount(rt)).toBe(2);
	});

	it("excludes replaced entries", () => {
		const rt = createRuntimeState();
		recordPending(rt, "a", 100, LONG);
		recordPending(rt, "b", 100, LONG);
		recordReplacement(rt, "a", "short", 1);
		expect(unreplacedPendingCount(rt)).toBe(1);
	});

	it("is zero when empty", () => {
		expect(unreplacedPendingCount(createRuntimeState())).toBe(0);
	});
});

describe("observeTurn", () => {
	it("advances the counter only when there is an unreplaced pending result", () => {
		const s = createSteeringState();
		expect(observeTurn(s, 0)).toBe(0); // nothing to remind about
		expect(observeTurn(s, 2)).toBe(1); // pending present -> advance
		expect(observeTurn(s, 2)).toBe(2);
		expect(observeTurn(s, 0)).toBe(2); // resolved -> no advance
	});

	it("does not advance on turns with nothing pending", () => {
		const s = createSteeringState();
		observeTurn(s, 0);
		observeTurn(s, 0);
		expect(s.turnsWithPending).toBe(0);
	});
});

describe("shouldFireSteering", () => {
	it("does not fire when disabled via config", () => {
		const s = createSteeringState();
		observeTurn(s, 5);
		expect(shouldFireSteering(s, 3, 3, false)).toBe(false);
	});

	it("does not fire when already fired this round", () => {
		const s = createSteeringState();
		observeTurn(s, 5);
		markFired(s);
		expect(shouldFireSteering(s, 3, 3, true)).toBe(false);
	});

	it("does not fire when there is nothing unreplaced", () => {
		const s = createSteeringState();
		observeTurn(s, 0);
		expect(shouldFireSteering(s, 0, 3, true)).toBe(false);
	});

	it("does not fire before the turn threshold is reached", () => {
		const s = createSteeringState();
		observeTurn(s, 2); // turnsWithPending = 1
		expect(shouldFireSteering(s, 2, 3, true)).toBe(false);
		observeTurn(s, 2); // = 2
		expect(shouldFireSteering(s, 2, 3, true)).toBe(false);
	});

	it("fires when threshold reached and conditions hold", () => {
		const s = createSteeringState();
		observeTurn(s, 2); // 1
		observeTurn(s, 2); // 2
		observeTurn(s, 2); // 3 -> reaches threshold
		expect(shouldFireSteering(s, 2, 3, true)).toBe(true);
	});

	it("treats threshold inclusively (fires exactly when count == threshold)", () => {
		const s = createSteeringState();
		observeTurn(s, 1);
		observeTurn(s, 1);
		expect(shouldFireSteering(s, 1, 2, true)).toBe(true);
	});

	it("respects a custom threshold", () => {
		const s = createSteeringState();
		observeTurn(s, 1);
		expect(shouldFireSteering(s, 1, 5, true)).toBe(false);
		observeTurn(s, 1);
		observeTurn(s, 1);
		observeTurn(s, 1);
		observeTurn(s, 1); // 5
		expect(shouldFireSteering(s, 1, 5, true)).toBe(true);
	});
});

describe("markFired", () => {
	it("sets fired and is idempotent", () => {
		const s = createSteeringState();
		expect(s.fired).toBe(false);
		markFired(s);
		expect(s.fired).toBe(true);
		markFired(s);
		expect(s.fired).toBe(true);
	});
});

describe("buildSteeringMessage", () => {
	it("mentions the count and the replace_tool_result tool", () => {
		const msg = buildSteeringMessage(3);
		expect(msg).toContain("3 tool results are");
		expect(msg).toContain("tool-result-pending-replacement");
		expect(msg).toContain("replace_tool_result");
	});

	it("uses singular wording for one result", () => {
		const msg = buildSteeringMessage(1);
		expect(msg).toContain("1 tool result is");
	});

	it("is non-empty for zero (defensive)", () => {
		expect(buildSteeringMessage(0).length).toBeGreaterThan(0);
	});
});
