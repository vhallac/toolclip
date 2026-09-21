/**
 * Unit tests for the quarantine store operations (lib/quarantine.ts).
 *
 * Anchored on the "held until read; freed after reading" contract:
 *   - A payload is held from quarantine until a read releases it; there is
 *     no eviction and no expiry — a read is honored at any later turn.
 *   - A release destroys the payload; a second read for the same id is
 *     denied.
 */

import { describe, expect, it } from "vitest";
import { createRuntimeState } from "../lib/runtime-state.ts";
import {
	recordQuarantine,
	releaseQuarantine,
	quarantineIds,
} from "../lib/quarantine.ts";
import {
	buildQuarantineNotice,
	buildQuarantineMissedNotice,
} from "../lib/quarantine.ts";

describe("quarantine store", () => {
	it("records and releases a payload; release removes the entry", () => {
		const state = createRuntimeState();
		recordQuarantine(state, "bash-1", "the full output", 12000, 0);

		const released = releaseQuarantine(state, "bash-1");
		expect(released).toEqual({ payload: "the full output", tokens: 12000, createdTurn: 0 });
		expect(quarantineIds(state)).toEqual([]);
	});

	it("returns undefined when releasing an id that is not held", () => {
		const state = createRuntimeState();
		expect(releaseQuarantine(state, "nope")).toBeUndefined();
	});

	it("denies a second read for an id that was already released", () => {
		const state = createRuntimeState();
		recordQuarantine(state, "bash-1", "payload", 12000, 0);
		releaseQuarantine(state, "bash-1");
		expect(releaseQuarantine(state, "bash-1")).toBeUndefined();
	});

	it("holds a payload across turn boundaries — no eviction, no expiry", () => {
		const state = createRuntimeState();
		recordQuarantine(state, "bash-1", "payload", 12000, 0);

		// Any number of turns may pass; nothing evicts the payload. The read
		// window is the rest of the session, not one turn.
		expect(quarantineIds(state)).toEqual(["bash-1"]);
		expect(releaseQuarantine(state, "bash-1")).toMatchObject({ payload: "payload" });
	});

	it("overwrite for the same id keeps only the latest payload", () => {
		const state = createRuntimeState();
		recordQuarantine(state, "bash-1", "first", 11000, 0);
		recordQuarantine(state, "bash-1", "second", 13000, 1);

		const released = releaseQuarantine(state, "bash-1");
		expect(released).toEqual({ payload: "second", tokens: 13000, createdTurn: 1 });
	});
});

describe("quarantine notices", () => {
	it("the quarantine notice carries the marker, the read instruction, and the hold-until-read rule", () => {
		const notice = buildQuarantineNotice("abc-1", 12000);
		expect(notice).toContain("[tool-result-quarantined: toolCallId=abc-1, tokens=12000]");
		expect(notice).toContain('read_quarantined_result({ toolCallId: "abc-1" })');
		// Hold-until-read semantics, stated neutrally (no deadline, no
		// urgency — the former urgency collided with the steering nag).
		expect(notice).toContain("held until you read it");
		expect(notice).toContain("a second read of the same id is denied");
		expect(notice).not.toContain("very next response");
		expect(notice).not.toContain("only chance");
		// The part-of-data path (narrowing the call) is stated before the read.
		expect(notice.indexOf("narrower scope")).toBeLessThan(notice.indexOf("read_quarantined_result"));
		// Anti-piecemeal directive: whole payload → one full read, never
		// several narrowed calls (the distill-refetch failure observed in the
		// 2026-09-20 pro golden run).
		expect(notice).toContain("If you need the whole payload");
		expect(notice).toContain("Do NOT reconstruct the payload piecemeal");
		expect(notice).toContain("more calls and more tokens than one full read");
	});

	it("the missed denial says the payload was read and points to a narrower re-run", () => {
		const notice = buildQuarantineMissedNotice("abc-1");
		expect(notice).toContain("[quarantine-missed: toolCallId=abc-1]");
		expect(notice).toContain("already read");
		expect(notice).toContain("no longer retrievable");
		expect(notice).toContain("narrower scope");
	});
});