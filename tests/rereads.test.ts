import { describe, expect, it } from "vitest";
import {
	observeRead,
	buildRereadDetails,
	resetRereads,
	type RereadTracker,
} from "../lib/rereads.ts";

describe("observeRead", () => {
	it("returns 1 on the first read of a path", () => {
		const tracker: RereadTracker = new Map();
		expect(observeRead(tracker, "/a.ts")).toBe(1);
	});

	it("accumulates across reads of the same path", () => {
		const tracker: RereadTracker = new Map();
		expect(observeRead(tracker, "/a.ts")).toBe(1);
		expect(observeRead(tracker, "/a.ts")).toBe(2);
		expect(observeRead(tracker, "/a.ts")).toBe(3);
	});

	it("tracks paths independently", () => {
		const tracker: RereadTracker = new Map();
		expect(observeRead(tracker, "/a.ts")).toBe(1);
		expect(observeRead(tracker, "/b.ts")).toBe(1);
		expect(observeRead(tracker, "/a.ts")).toBe(2);
	});
});

describe("buildRereadDetails", () => {
	it("returns undefined for a first read (count < 2)", () => {
		expect(buildRereadDetails("/a.ts", 1)).toBeUndefined();
	});

	it("returns the payload from the second read on", () => {
		expect(buildRereadDetails("/a.ts", 2)).toEqual({
			toolclipReread: { path: "/a.ts", count: 2 },
		});
		expect(buildRereadDetails("/a.ts", 5)).toEqual({
			toolclipReread: { path: "/a.ts", count: 5 },
		});
	});
});

describe("resetRereads", () => {
	it("wipes the per-round counter", () => {
		const tracker: RereadTracker = new Map();
		observeRead(tracker, "/a.ts");
		observeRead(tracker, "/a.ts");
		resetRereads(tracker);
		expect(observeRead(tracker, "/a.ts")).toBe(1);
	});
});