import { describe, expect, it } from "vitest";
import {
	clear,
	createRuntimeState,
	getEntry,
	getReplacement,
	pendingIds,
	recordContextToolCallIds,
	recordPending,
	recordReplacement,
	replacedIds,
} from "../lib/runtime-state.js";
import { countNewlyEligible } from "../lib/expiry.ts";

describe("createRuntimeState", () => {
	it("starts empty", () => {
		const state = createRuntimeState();
		expect(state.entries.size).toBe(0);
		expect(pendingIds(state)).toEqual([]);
		expect(replacedIds(state)).toEqual([]);
	});

	it("returns a fresh instance each call (no shared state)", () => {
		const a = createRuntimeState();
		const b = createRuntimeState();
		recordPending(a, "x", 10, "content");
		expect(b.entries.size).toBe(0);
	});
});

describe("recordPending", () => {
	it("stores an entry with originalTokens and originalContent", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "the original payload");
		const entry = getEntry(state, "abc");
		expect(entry).toBeDefined();
		expect(entry?.originalTokens).toBe(500);
		expect(entry?.originalContent).toBe("the original payload");
		expect(entry?.replacement).toBeUndefined();
	});

	it("records the id as pending (not yet replaced)", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "x");
		expect(pendingIds(state)).toEqual(["abc"]);
		expect(replacedIds(state)).toEqual([]);
	});

	it("overwrites a previous entry for the same id (latest write wins)", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "first");
		recordPending(state, "abc", 700, "second");
		const entry = getEntry(state, "abc");
		expect(entry?.originalTokens).toBe(700);
		expect(entry?.originalContent).toBe("second");
		expect(pendingIds(state)).toEqual(["abc"]);
	});

	it("records multiple ids independently", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 1, "A");
		recordPending(state, "b", 2, "B");
		recordPending(state, "c", 3, "C");
		expect(pendingIds(state)).toEqual(["a", "b", "c"]);
	});
});

describe("recordReplacement", () => {
	it("stores the replacement on an existing pending entry", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "the original payload");
		const stored = recordReplacement(state, "abc", "tight summary", 3);
		expect(stored).toBe(true);
		expect(getReplacement(state, "abc")).toBe("tight summary");
	});

	it("moves the id from pending to replaced", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "x");
		expect(pendingIds(state)).toEqual(["abc"]);
		recordReplacement(state, "abc", "tight", 3);
		expect(pendingIds(state)).toEqual([]);
		expect(replacedIds(state)).toEqual(["abc"]);
	});

	it("is a no-op for an unknown id and returns false", () => {
		const state = createRuntimeState();
		const stored = recordReplacement(state, "never-recorded", "tight", 3);
		expect(stored).toBe(false);
		expect(getEntry(state, "never-recorded")).toBeUndefined();
		expect(pendingIds(state)).toEqual([]);
		expect(replacedIds(state)).toEqual([]);
	});

	it("preserves originalTokens and originalContent when replacing", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "the full original");
		recordReplacement(state, "abc", "tight", 3);
		const entry = getEntry(state, "abc");
		expect(entry?.originalTokens).toBe(500);
		expect(entry?.originalContent).toBe("the full original");
		expect(entry?.replacement).toBe("tight");
	});

	it("records replacementTokens and sets grew=false when smaller than original", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "x");
		recordReplacement(state, "abc", "tight", 3);
		const entry = getEntry(state, "abc");
		expect(entry?.replacementTokens).toBe(3);
		expect(entry?.grew).toBe(false);
	});

	it("sets grew=true when replacement is at least as large as original", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "x");
		// replacement >= original → grew flag set (observation target)
		recordReplacement(state, "abc", "x".repeat(2000), 500);
		expect(getEntry(state, "abc")?.grew).toBe(true);
	});

	it("sets grew=true when replacement exactly equals original tokens", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "x");
		recordReplacement(state, "abc", "same size", 500);
		expect(getEntry(state, "abc")?.grew).toBe(true);
	});

	it("can be applied multiple times — latest replacement wins", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "x");
		recordReplacement(state, "abc", "first", 5);
		recordReplacement(state, "abc", "second", 6);
		expect(getReplacement(state, "abc")).toBe("second");
		expect(getEntry(state, "abc")?.replacementTokens).toBe(6);
	});
});

describe("getReplacement", () => {
	it("returns undefined for an unknown id", () => {
		const state = createRuntimeState();
		expect(getReplacement(state, "nope")).toBeUndefined();
	});

	it("returns undefined for a pending (un-replaced) entry", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "x");
		expect(getReplacement(state, "abc")).toBeUndefined();
	});

	it("returns the stored replacement for a replaced entry", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "x");
		recordReplacement(state, "abc", "tight", 3);
		expect(getReplacement(state, "abc")).toBe("tight");
	});
});

	describe("clear", () => {
		it("wipes all entries", () => {
			const state = createRuntimeState();
			recordPending(state, "a", 1, "A");
			recordPending(state, "b", 2, "B");
			recordReplacement(state, "a", "ta", 1);
			clear(state);
			expect(state.entries.size).toBe(0);
			expect(pendingIds(state)).toEqual([]);
			expect(replacedIds(state)).toEqual([]);
		});

		it("resets the expiry accounting to fresh defaults", () => {
			const state = createRuntimeState({ rho: 0.1, writeRatio: 1.25 });
			recordPending(state, "a", 500, "A");
			recordContextToolCallIds(state, ["a"]);
			countNewlyEligible(state, 20000);
			state.turnsSeen = 7;
			state.lastCtx = 20000;
			state.noCacheStreak = 2;
			state.expiredIds.add("ghost");
			state.expiredUnannounced.add("ghost");

			clear(state);
			expect(state.pileTotal).toBe(0);
			expect(state.turnsSeen).toBe(0);
			expect(state.lastCtx).toBe(0);
			expect(state.rho).toBe(0.2);
			expect(state.w).toBe(1.0);
			expect(state.noCacheStreak).toBe(0);
			expect(state.replMeanTokens).toBe(0);
			expect(state.replCount).toBe(0);
			expect(state.expiredIds.size).toBe(0);
			expect(state.expiredUnannounced.size).toBe(0);
		});
	});

	describe("recordPending — pileTotal correction on re-mark", () => {
		it("subtracts a counted entry's stale contribution when the result is re-recorded", () => {
			const state = createRuntimeState();
			recordPending(state, "a", 300, "first");
			recordContextToolCallIds(state, ["a"]);
			countNewlyEligible(state, 5000);
			expect(state.pileTotal).toBe(300);

			// Same id re-marked (tool retried, fresh content): the counted
			// contribution of the old content must not linger in the pile.
			recordPending(state, "a", 700, "second");
			expect(state.pileTotal).toBe(0);
			expect(state.entries.get("a")).toMatchObject({ counted: false, ctxSeen: 0 });

			// It re-counts with a fresh ctxSeen once eligible again.
			recordContextToolCallIds(state, ["a"]);
			countNewlyEligible(state, 9000);
			expect(state.pileTotal).toBe(700);
			expect(state.entries.get("a")).toMatchObject({ counted: true, ctxSeen: 9000 });
		});

		it("leaves pileTotal alone when overwriting an uncounted entry", () => {
			const state = createRuntimeState();
			recordPending(state, "a", 300, "first");
			recordPending(state, "a", 700, "second");
			expect(state.pileTotal).toBe(0);
		});
	});
