import { describe, expect, it } from "vitest";
import {
	compactTracked,
	countNewlyEligible,
	evaluateExpiry,
	isTracked,
	observeReplacement,
	observeTurnUsage,
	recomputePileTotal,
	resetPileTotalAfterStores,
	trackedSummary,
	EXPIRED_ANNOUNCE_CAP,
} from "../lib/expiry.ts";
import type { ExpirySettings, TurnUsage } from "../lib/expiry.ts";
import {
	createRuntimeState,
	recordContextToolCallIds,
	recordPending,
	recordReplacement,
} from "../lib/runtime-state.ts";
import type { ToolclipRuntimeState } from "../lib/types.ts";

const LONG = "x".repeat(2000); // filler content; token counts are passed explicitly

/** The spec's default expiry knobs. */
const SETTINGS: ExpirySettings = {
	replacementTokens: 170,
	copies: 2,
	overheadTokens: 60,
	horizonMinTurns: 10,
	horizonMaxTurns: 100,
};

/** Defaults: rho 0.2, w 1.0 → phi = 0.25. */
function makeState(): ToolclipRuntimeState {
	return createRuntimeState();
}

/** Record + count an entry in one step (the first turn_end where it is eligible). */
function countEntry(
	state: ToolclipRuntimeState,
	id: string,
	tokens: number,
	ctxT: number,
): void {
	recordPending(state, id, tokens, LONG);
	const ids = new Set(state.lastContextToolCallIds);
	ids.add(id);
	recordContextToolCallIds(state, [...ids]);
	countNewlyEligible(state, ctxT);
}

function usage(partial: Partial<TurnUsage>): TurnUsage {
	return {
		ctxT: 20000,
		input: 10000,
		output: 100,
		cacheRead: 9000,
		cacheWrite: 1000,
		...partial,
	};
}

// ---------------------------------------------------------------------------
// observeTurnUsage — prices, streaks, counters.
// ---------------------------------------------------------------------------
describe("observeTurnUsage", () => {
	it("bumps turnsSeen and records lastCtx", () => {
		const state = createRuntimeState();
		observeTurnUsage(state, usage({ ctxT: 12345 }));
		observeTurnUsage(state, usage({ ctxT: 23456 }));
		expect(state.turnsSeen).toBe(2);
		expect(state.lastCtx).toBe(23456);
	});

	it("keeps the priors when the measured ratios match them exactly", () => {
		const state = createRuntimeState();
		// pCr/pIn = 0.18/9000 / (1.0/10000) = 0.2; pCw/pIn = 0.1/1000 / 1e-4 = 1.0.
		observeTurnUsage(state, usage({ cost: { input: 1.0, output: 3, cacheRead: 0.18, cacheWrite: 0.1, total: 1.4 } }));
		expect(state.rho).toBeCloseTo(0.2, 10);
		expect(state.w).toBeCloseTo(1.0, 10);
	});

	it("EMA-updates rho and w toward the measured ratios (alpha 0.3)", () => {
		const state = createRuntimeState();
		// Measured cache-read ratio 0.5: rho += 0.3 * (0.5 - 0.2) = 0.29.
		observeTurnUsage(state, usage({ cost: { input: 1.0, output: 3, cacheRead: 0.45, cacheWrite: 0.1, total: 1.6 } }));
		expect(state.rho).toBeCloseTo(0.29, 10);
		// Measured write ratio 2.0: w += 0.3 * (2.0 - 1.0) = 1.3.
		observeTurnUsage(state, usage({ cost: { input: 1.0, output: 3, cacheRead: 0.18, cacheWrite: 0.2, total: 1.4 } }));
		expect(state.w).toBeCloseTo(1.3, 10);
	});

	it("clamps observed ratios into [0.01, 1] and [1, 4]", () => {
		const state = createRuntimeState();
		// Cache-read ratio 5 → clamped to 1: rho += 0.3 * (1 - 0.2) = 0.44.
		observeTurnUsage(state, usage({ cost: { input: 1.0, output: 3, cacheRead: 4.5, cacheWrite: 0.1, total: 5.6 } }));
		expect(state.rho).toBeCloseTo(0.44, 10);
		// Write ratio 0.5 → clamped to 1: w stays 1.0.
		observeTurnUsage(state, usage({ cost: { input: 1.0, output: 3, cacheRead: 0.18, cacheWrite: 0.05, total: 1.2 } }));
		expect(state.w).toBeCloseTo(1.0, 10);
	});

	it("discards the whole price observation when a cost field is negative or non-finite", () => {
		const state = createRuntimeState();
		observeTurnUsage(state, usage({ cost: { input: -1.0, output: 3, cacheRead: 0.18, cacheWrite: 0.1, total: 0 } }));
		expect(state.rho).toBe(0.2);
		expect(state.w).toBe(1.0);
		observeTurnUsage(state, usage({ cost: { input: 1.0, output: 3, cacheRead: Number.NaN, cacheWrite: 0.1, total: 0 } }));
		expect(state.rho).toBe(0.2);
		expect(state.w).toBe(1.0);
	});

	it("skips a price whose token denominator is below the 100-token floor", () => {
		const state = createRuntimeState();
		// cacheRead 50 < 100: no rho update; cacheWrite 1000: w update applies.
		observeTurnUsage(state, usage({ cacheRead: 50, ctxT: 10050, cost: { input: 1.0, output: 3, cacheRead: 0.01, cacheWrite: 0.2, total: 1.3 } }));
		expect(state.rho).toBe(0.2);
		expect(state.w).toBeCloseTo(1.3, 10);
	});

	it("maintains noCacheStreak: increments with no cache activity, resets otherwise", () => {
		const state = createRuntimeState();
		observeTurnUsage(state, usage({ cacheRead: 0, cacheWrite: 0, ctxT: 20000 }));
		expect(state.noCacheStreak).toBe(1);
		observeTurnUsage(state, usage({ cacheRead: 0, cacheWrite: 0, ctxT: 21000 }));
		expect(state.noCacheStreak).toBe(2);
		// Cache activity resets the streak. So does a too-small context.
		observeTurnUsage(state, usage({ cacheRead: 500, cacheWrite: 0, ctxT: 500 }));
		expect(state.noCacheStreak).toBe(0);
		observeTurnUsage(state, usage({ cacheRead: 0, cacheWrite: 0, ctxT: 1999 }));
		expect(state.noCacheStreak).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// countNewlyEligible / compaction / pileTotal resets.
// ---------------------------------------------------------------------------
describe("countNewlyEligible", () => {
	it("counts eligible pending entries into pileTotal with ctxSeen = ctxT", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 3000, LONG);
		recordPending(state, "b", 1000, LONG);
		recordContextToolCallIds(state, ["a", "b"]);
		const added = countNewlyEligible(state, 20000);
		expect(added).toBe(2);
		expect(state.pileTotal).toBe(4000);
		expect(state.entries.get("a")).toMatchObject({ counted: true, ctxSeen: 20000 });
	});

	it("is idempotent: a counted entry is not counted twice", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 3000, LONG);
		recordContextToolCallIds(state, ["a"]);
		countNewlyEligible(state, 20000);
		const again = countNewlyEligible(state, 21000);
		expect(again).toBe(0);
		expect(state.pileTotal).toBe(3000);
		// ctxSeen keeps the FIRST counting turn's ctx_t.
		expect(state.entries.get("a")?.ctxSeen).toBe(20000);
	});

	it("skips entries marked this turn (id not in the last context event)", () => {
		const state = createRuntimeState();
		recordPending(state, "fresh", 3000, LONG);
		recordContextToolCallIds(state, []);
		expect(countNewlyEligible(state, 20000)).toBe(0);
		expect(state.pileTotal).toBe(0);
	});

	it("skips replaced entries and expired ids (expiry is monotone)", () => {
		const state = createRuntimeState();
		recordPending(state, "gone", 3000, LONG);
		state.expiredIds.add("gone");
		recordContextToolCallIds(state, ["gone"]);
		expect(countNewlyEligible(state, 20000)).toBe(0);
		recordPending(state, "replaced", 1000, LONG);
		recordReplacement(state, "replaced", "short", 2);
		recordContextToolCallIds(state, ["gone", "replaced"]);
		expect(countNewlyEligible(state, 20000)).toBe(0);
		expect(state.pileTotal).toBe(0);
	});
});

describe("compactTracked", () => {
	it("removes counted pending entries whose id left the messages, and recomputes pileTotal", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 3000, LONG);
		recordPending(state, "b", 1000, LONG);
		recordContextToolCallIds(state, ["a", "b"]);
		countNewlyEligible(state, 20000);
		expect(state.pileTotal).toBe(4000);

		// "b" is compacted away.
		recordContextToolCallIds(state, ["a"]);
		const removed = compactTracked(state);
		expect(removed).toBe(true);
		expect(state.entries.has("b")).toBe(false);
		expect(state.pileTotal).toBe(3000);
	});

	it("keeps replaced entries even when out of the messages (the swap still needs them)", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 3000, LONG);
		recordPending(state, "b", 1000, LONG);
		recordContextToolCallIds(state, ["a", "b"]);
		countNewlyEligible(state, 20000);
		recordReplacement(state, "b", "short", 10);
		// Mimic the tool handler's post-store reset (recordReplacement called
		// directly bypasses it): the pile drops the replaced original.
		resetPileTotalAfterStores(state);
		recordContextToolCallIds(state, ["a"]);
		compactTracked(state);
		expect(state.entries.has("b")).toBe(true); // replaced entries stay
		expect(state.pileTotal).toBe(3000);
	});

	it("keeps uncounted entries (marked during the current turn)", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 3000, LONG);
		recordContextToolCallIds(state, ["a"]);
		countNewlyEligible(state, 20000);
		// Marked this turn: not yet counted, id not in the last context event.
		recordPending(state, "fresh", 1000, LONG);
		compactTracked(state);
		expect(state.entries.has("fresh")).toBe(true);
		expect(state.pileTotal).toBe(3000);
	});

	it("does NOT recompute pileTotal when nothing was removed (expired mass survives)", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 3000, LONG);
		recordContextToolCallIds(state, ["a"]);
		countNewlyEligible(state, 20000);
		// Simulate expired mass still counted in the total (expiry deleted
		// its entries but left pileTotal alone): 3000 live + 27000 expired.
		state.pileTotal += 27000;
		const removed = compactTracked(state);
		expect(removed).toBe(false);
		expect(state.pileTotal).toBe(30000);
	});
});

describe("pileTotal resets", () => {
	it("resetPileTotalAfterStores recomputes over tracked entries", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 3000, LONG);
		recordPending(state, "b", 1000, LONG);
		recordPending(state, "c", 500, LONG);
		recordContextToolCallIds(state, ["a", "b", "c"]);
		countNewlyEligible(state, 20000);
		recordReplacement(state, "b", "short", 10);
		// Simulated expired mass (entry deleted, total untouched).
		state.pileTotal += 27000;
		expect(resetPileTotalAfterStores(state)).toBe(3500);
		expect(state.pileTotal).toBe(3500);
	});

	it("recomputePileTotal drops replaced and expired entries", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 3000, LONG);
		recordPending(state, "b", 1000, LONG);
		recordContextToolCallIds(state, ["a", "b"]);
		countNewlyEligible(state, 20000);
		recordReplacement(state, "a", "short", 10);
		state.entries.delete("b");
		state.expiredIds.add("b");
		expect(recomputePileTotal(state)).toBe(0);
	});
});

describe("observeReplacement — running mean", () => {
	it("tracks count and incremental mean", () => {
		const state = createRuntimeState();
		observeReplacement(state, 100);
		expect(state.replCount).toBe(1);
		expect(state.replMeanTokens).toBe(100);
		observeReplacement(state, 200);
		expect(state.replCount).toBe(2);
		expect(state.replMeanTokens).toBe(150);
		observeReplacement(state, 300);
		expect(state.replCount).toBe(3);
		expect(state.replMeanTokens).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// evaluateExpiry — the pay-back test.
// ---------------------------------------------------------------------------
describe("evaluateExpiry", () => {
	it("worked example 1: T=3000 expires between S=20000 and S=30000 at turnsSeen 40", () => {
		const state = createRuntimeState(); // rho 0.2, w 1.0 → phi 0.25
		state.turnsSeen = 40;
		countEntry(state, "e", 3000, 20000);
		expect(state.pileTotal).toBe(3000);

		// net = 3000 - 2*170 - 60 = 2600; threshold = 0.25 * 2600 * 40 = 26000.
		expect(evaluateExpiry(state, 40000, SETTINGS)).toEqual([]); // S = 20000: live
		expect(state.entries.has("e")).toBe(true);
		expect(evaluateExpiry(state, 46000, SETTINGS)).toEqual([]); // S = 26000: equal to the rung — strict comparison, live
		expect(state.entries.has("e")).toBe(true);
		expect(evaluateExpiry(state, 46001, SETTINGS)).toEqual(["e"]); // S = 26001 > 26000 → expired
		expect(state.entries.has("e")).toBe(false);
		expect(state.expiredIds.has("e")).toBe(true);
		expect(state.expiredUnannounced.has("e")).toBe(true);
		// Expiry never modifies pileTotal.
		expect(state.pileTotal).toBe(3000);
	});

	it("worked example 2: same entry at turnsSeen 5 uses the floor horizon H=10 (threshold 6500)", () => {
		const state = createRuntimeState();
		state.turnsSeen = 5;
		countEntry(state, "e", 3000, 20000);
		// S = 6500: 0.25 * 2600 * 10 = 6500 — not strictly above → live.
		expect(evaluateExpiry(state, 26500, SETTINGS)).toEqual([]);
		// S = 6501 → expired.
		expect(evaluateExpiry(state, 26501, SETTINGS)).toEqual(["e"]);
	});

	it("worked example 3: Anthropic-style priors (rho 0.1, w 1.25) tighten the threshold", () => {
		const state = createRuntimeState({ rho: 0.1, writeRatio: 1.25 });
		state.turnsSeen = 20;
		countEntry(state, "e", 3000, 20000);
		// phi = 0.1/1.15 = 0.08696; threshold = 0.08696 * 2600 * 20 = 4521.7.
		expect(evaluateExpiry(state, 24521, SETTINGS)).toEqual([]); // S = 4521
		expect(evaluateExpiry(state, 24522, SETTINGS)).toEqual(["e"]); // S = 4522
	});

	it("worked example 5: net <= 0 expires immediately (T=1050, measured R=500)", () => {
		const state = createRuntimeState();
		state.turnsSeen = 3;
		state.replCount = 3;
		state.replMeanTokens = 500;
		countEntry(state, "e", 1050, 20000);
		// net = 1050 - 1000 - 60 = -10 → expired on the first evaluation, S = 0.
		expect(evaluateExpiry(state, 20000, SETTINGS)).toEqual(["e"]);
	});

	it("uses the measured replacement mean only once 3 replacements are seen; clamps R to [50, 1000]", () => {
		// Below 3 observations: the prior is used. R prior 170 → net(3000) = 2600.
		const prior = createRuntimeState();
		prior.turnsSeen = 40;
		prior.replCount = 2;
		prior.replMeanTokens = 900;
		countEntry(prior, "e", 3000, 20000);
		expect(evaluateExpiry(prior, 46001, SETTINGS)).toEqual(["e"]); // threshold 26000 (R=170)

		// At 3 observations the mean applies, clamped: mean 5000 → R = 1000.
		const clamped = createRuntimeState();
		clamped.turnsSeen = 40;
		clamped.replCount = 3;
		clamped.replMeanTokens = 5000;
		countEntry(clamped, "e", 3000, 20000);
		// net = 3000 - 2000 - 60 = 940; threshold = 0.25 * 940 * 40 = 9400.
		expect(evaluateExpiry(clamped, 29400, SETTINGS)).toEqual([]); // S = 9400
		expect(evaluateExpiry(clamped, 29401, SETTINGS)).toEqual(["e"]); // S = 9401
	});

	it("freezes expiry after 3 consecutive no-cache turns (phi = infinity), but net <= 0 still expires", () => {
		const state = createRuntimeState();
		state.turnsSeen = 40;
		state.noCacheStreak = 3;
		countEntry(state, "e", 3000, 20000);
		countEntry(state, "tiny", 200, 20000);
		// S = 100000 would otherwise expire long before; frozen → live. The
		// net-negative entry expires in the same evaluation pass.
		expect(evaluateExpiry(state, 120000, SETTINGS)).toEqual(["tiny"]);
		expect(state.entries.has("e")).toBe(true);
		expect(state.entries.has("tiny")).toBe(false);
	});

	it("treats w <= rho as phi = infinity (nothing expires by time)", () => {
		const state = createRuntimeState({ rho: 0.5, writeRatio: 0.4 });
		state.turnsSeen = 40;
		countEntry(state, "e", 3000, 20000);
		expect(evaluateExpiry(state, 120000, SETTINGS)).toEqual([]);
	});

	it("never touches replaced or uncounted entries", () => {
		const state = createRuntimeState();
		state.turnsSeen = 40;
		countEntry(state, "tracked", 3000, 20000);
		recordPending(state, "replaced", 3000, LONG);
		recordReplacement(state, "replaced", "short", 10);
		recordPending(state, "uncounted", 3000, LONG);
		recordContextToolCallIds(state, ["tracked", "replaced"]); // "uncounted" not in context
		expect(evaluateExpiry(state, 120000, SETTINGS)).toEqual(["tracked"]);
		expect(state.entries.has("replaced")).toBe(true);
		expect(state.entries.has("uncounted")).toBe(true);
	});

	it("caps expiredUnannounced at 20 ids while expiredIds grows without limit", () => {
		const state = createRuntimeState();
		state.turnsSeen = 40;
		for (let i = 0; i < 25; i++) {
			countEntry(state, `e${i}`, 400, 20000); // net = 400 - 340 - 60 = 0 → immediate
		}
		const expired = evaluateExpiry(state, 20000, SETTINGS);
		expect(expired).toHaveLength(25);
		expect(state.expiredIds.size).toBe(25);
		expect(state.expiredUnannounced.size).toBe(EXPIRED_ANNOUNCE_CAP);
	});
});

// ---------------------------------------------------------------------------
// trackedSummary — the nag's live view.
// ---------------------------------------------------------------------------
describe("trackedSummary", () => {
	it("collects live tracked entries whose ids are in the last context event", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 100, LONG);
		recordPending(state, "b", 250, LONG);
		recordContextToolCallIds(state, ["a", "b"]);
		countNewlyEligible(state, 20000);
		const summary = trackedSummary(state);
		expect(summary.items).toEqual([
			{ id: "a", tokens: 100 },
			{ id: "b", tokens: 250 },
		]);
		expect(summary.totalTokens).toBe(350);
	});

	it("excludes replaced entries even when still in the messages", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 100, LONG);
		recordPending(state, "b", 250, LONG);
		recordContextToolCallIds(state, ["a", "b"]);
		countNewlyEligible(state, 20000);
		recordReplacement(state, "a", "short", 1);
		const summary = trackedSummary(state);
		expect(summary.items).toEqual([{ id: "b", tokens: 250 }]);
		expect(summary.totalTokens).toBe(250);
	});

	it("excludes uncounted entries (marked this turn) and entries whose id left the context", () => {
		const state = createRuntimeState();
		recordPending(state, "seen", 400, LONG);
		recordPending(state, "fresh-this-turn", 300, LONG);
		recordPending(state, "compacted-away", 200, LONG);
		recordContextToolCallIds(state, ["seen", "compacted-away"]);
		countNewlyEligible(state, 20000);
		// "compacted-away" leaves the messages; "fresh-this-turn" is marked now.
		recordContextToolCallIds(state, ["seen"]);
		const summary = trackedSummary(state);
		expect(summary.items).toEqual([{ id: "seen", tokens: 400 }]);
		expect(summary.totalTokens).toBe(400);
	});

	it("excludes expired entries", () => {
		const state = createRuntimeState();
		state.turnsSeen = 40;
		countEntry(state, "dead", 400, 20000); // net = 400 - 340 - 60 = 0 → immediate
		expect(evaluateExpiry(state, 20000, SETTINGS)).toEqual(["dead"]);
		expect(trackedSummary(state)).toEqual({ items: [], totalTokens: 0 });
	});

	it("tracks only the most recent context event (later events replace the id set)", () => {
		const state = createRuntimeState();
		recordPending(state, "old", 500, LONG);
		recordPending(state, "new", 700, LONG);
		recordContextToolCallIds(state, ["old"]);
		countNewlyEligible(state, 20000);
		// Only "new" is in the latest context event; it becomes counted there.
		recordContextToolCallIds(state, ["new"]);
		countNewlyEligible(state, 20000);
		const summary = trackedSummary(state);
		expect(summary.items).toEqual([{ id: "new", tokens: 700 }]);
		expect(summary.totalTokens).toBe(700);
	});

	it("is empty when no context event has fired yet", () => {
		const state = createRuntimeState();
		recordPending(state, "a", 100, LONG);
		expect(trackedSummary(state)).toEqual({ items: [], totalTokens: 0 });
	});
});

describe("isTracked", () => {
	it("is true for pending, counted, non-expired entries and false otherwise", () => {
		const state = createRuntimeState();
		recordPending(state, "pending-counted", 100, LONG);
		recordContextToolCallIds(state, ["pending-counted"]);
		countNewlyEligible(state, 20000);
		recordPending(state, "pending-uncounted", 100, LONG);
		recordPending(state, "replaced", 100, LONG);
		recordReplacement(state, "replaced", "s", 1);
		recordPending(state, "expired", 100, LONG);
		state.expiredIds.add("expired");

		expect(isTracked(state, "pending-counted", state.entries.get("pending-counted")!)).toBe(true);
		expect(isTracked(state, "pending-uncounted", state.entries.get("pending-uncounted")!)).toBe(false);
		expect(isTracked(state, "replaced", state.entries.get("replaced")!)).toBe(false);
		expect(isTracked(state, "expired", state.entries.get("expired")!)).toBe(false);
	});
});