import { describe, expect, it } from "vitest";
import {
	clear,
	createRuntimeState,
	getEntry,
	getReplacement,
	pendingIds,
	recordPending,
	recordReplacement,
	replacedIds,
} from "../lib/runtime-state.js";

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
		const stored = recordReplacement(state, "abc", "tight summary");
		expect(stored).toBe(true);
		expect(getReplacement(state, "abc")).toBe("tight summary");
	});

	it("moves the id from pending to replaced", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "x");
		expect(pendingIds(state)).toEqual(["abc"]);
		recordReplacement(state, "abc", "tight");
		expect(pendingIds(state)).toEqual([]);
		expect(replacedIds(state)).toEqual(["abc"]);
	});

	it("is a no-op for an unknown id and returns false", () => {
		const state = createRuntimeState();
		const stored = recordReplacement(state, "never-recorded", "tight");
		expect(stored).toBe(false);
		expect(getEntry(state, "never-recorded")).toBeUndefined();
		expect(pendingIds(state)).toEqual([]);
		expect(replacedIds(state)).toEqual([]);
	});

	it("preserves originalTokens and originalContent when replacing", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "the full original");
		recordReplacement(state, "abc", "tight");
		const entry = getEntry(state, "abc");
		expect(entry?.originalTokens).toBe(500);
		expect(entry?.originalContent).toBe("the full original");
		expect(entry?.replacement).toBe("tight");
	});

	it("can be applied multiple times — latest replacement wins", () => {
		const state = createRuntimeState();
		recordPending(state, "abc", 500, "x");
		recordReplacement(state, "abc", "first");
		recordReplacement(state, "abc", "second");
		expect(getReplacement(state, "abc")).toBe("second");
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
		recordReplacement(state, "abc", "tight");
		expect(getReplacement(state, "abc")).toBe("tight");
	});
});

describe("clear", () => {
	it("wipes all entries", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 1, "A");
		recordPending(state, "b", 2, "B");
		recordReplacement(state, "a", "ta");
		clear(state);
		expect(state.entries.size).toBe(0);
		expect(pendingIds(state)).toEqual([]);
		expect(replacedIds(state)).toEqual([]);
	});
});
