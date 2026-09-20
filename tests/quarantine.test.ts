/**
 * Unit tests for the quarantine store operations (lib/quarantine.ts).
 *
 * Anchored on the "use it or lose it" contract:
 *   - A payload quarantined during turn N is released by a read issued any
 *     time before the turn_end of turn N+1 closes its window.
 *   - At the turn_end of turn N+1 (turnIndex = N+1), still-held entries are
 *     evicted; later reads for the id are denied.
 */

import { describe, expect, it } from "vitest";
import { createRuntimeState } from "../lib/runtime-state.ts";
import {
	recordQuarantine,
	releaseQuarantine,
	evictExpiredQuarantines,
	quarantineIds,
	clearQuarantines,
} from "../lib/quarantine.ts";
import { buildQuarantineNotice, buildQuarantineMissedNotice } from "../lib/quarantine.ts";

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

	it("overwrite for the same id keeps only the latest payload", () => {
		const state = createRuntimeState();
		recordQuarantine(state, "bash-1", "first", 11000, 0);
		recordQuarantine(state, "bash-1", "second", 13000, 1);

		const released = releaseQuarantine(state, "bash-1");
		expect(released).toEqual({ payload: "second", tokens: 13000, createdTurn: 1 });
	});

	it("eviction at turn_end(N) spares an entry quarantined during turn N", () => {
		const state = createRuntimeState();
		recordQuarantine(state, "bash-1", "payload", 12000, 0);

		// turn_end of the creating turn: the LLM has not even seen the notice
		// yet — nothing may be evicted.
		expect(evictExpiredQuarantines(state, 0)).toEqual([]);
		expect(quarantineIds(state)).toEqual(["bash-1"]);
	});

	it("eviction at turn_end(N+1) frees an entry quarantined during turn N that was not read", () => {
		const state = createRuntimeState();
		recordQuarantine(state, "bash-1", "payload", 12000, 0);

		// The read window (turn 1) closed without a read.
		expect(evictExpiredQuarantines(state, 1)).toEqual(["bash-1"]);
		expect(quarantineIds(state)).toEqual([]);
		// Future read attempts are denied.
		expect(releaseQuarantine(state, "bash-1")).toBeUndefined();
	});

	it("a read during the window is honored; eviction then only touches other stale ids", () => {
		const state = createRuntimeState();
		recordQuarantine(state, "bash-1", "payload-1", 12000, 0);
		recordQuarantine(state, "bash-2", "payload-2", 11000, 0);

		// Turn 1: LLM reads bash-1 only.
		expect(releaseQuarantine(state, "bash-1")).toMatchObject({ payload: "payload-1" });
		// turn_end of turn 1: bash-2 (unread) is evicted, bash-1 is already gone.
		expect(evictExpiredQuarantines(state, 1)).toEqual(["bash-2"]);
		expect(releaseQuarantine(state, "bash-2")).toBeUndefined();
	});

	it("an entry quarantined during the current turn survives that turn_end, even alongside older ones", () => {
		const state = createRuntimeState();
		recordQuarantine(state, "old", "old-payload", 12000, 0);

		// Turn 1 ends; a new quarantine was created during turn 1 itself.
		recordQuarantine(state, "new", "new-payload", 13000, 1);
		expect(evictExpiredQuarantines(state, 1)).toEqual(["old"]);
		expect(quarantineIds(state)).toEqual(["new"]);

		// The new one gets its window in turn 2 and is evicted at its end.
		expect(evictExpiredQuarantines(state, 2)).toEqual(["new"]);
	});

	it("clearQuarantines wipes every held entry", () => {
		const state = createRuntimeState();
		recordQuarantine(state, "a", "pa", 11000, 0);
		recordQuarantine(state, "b", "pb", 12000, 1);
		clearQuarantines(state);
		expect(quarantineIds(state)).toEqual([]);
	});
});

describe("quarantine notices", () => {
	it("the quarantine notice carries the marker plus the read instruction and the use-it-or-lose-it rule", () => {
		const notice = buildQuarantineNotice("abc-1", 12000);
		expect(notice).toContain("[tool-result-quarantined: toolCallId=abc-1, tokens=12000]");
		expect(notice).toContain('read_quarantined_result({ toolCallId: "abc-1" })');
		expect(notice).toContain("your very next response");
		expect(notice).toContain("later read attempts for it are denied");
		// The preferred path (refining the call) is stated before the read.
		expect(notice.indexOf("narrower scope")).toBeLessThan(notice.indexOf("read_quarantined_result"));
	});

	it("the missed notice denies further retrieval and points back to a narrower re-run", () => {
		const notice = buildQuarantineMissedNotice("abc-1");
		expect(notice).toContain("[quarantine-missed: toolCallId=abc-1]");
		expect(notice).toContain("no longer retrievable");
	});
});