/**
 * Expiry of stale pending replacements.
 *
 * The failure mode this targets: a pending result that has been sitting
 * un-replaced for so long that replacing it no longer pays back. Replacing
 * rewrites the cached suffix from the entry's position onward — a one-time
 * cache cost that grows with everything appended since the result was first
 * seen — while the saving is only the per-turn cache-read price of the
 * original minus the replacement's own footprint. Past a break-even point
 * the swap burns more than it saves, and at that point the entry is
 * "expired": deleted from the tracker, dropped from the nag, and any
 * replace call naming it is silently ignored (never an error — the model
 * must not be punished for acting on a list that has since gone stale).
 *
 * The pay-back model, in price units where the uncached input price is 1:
 *
 *   - Replacing costs `(w - rho) * S_i` once: the suffix from the entry's
 *     position (≈ everything appended since first sight, S_i) was cache-read
 *     at rho before and must be (re)written at w.
 *   - Replacing saves `rho * net_i` per later turn, where
 *     `net_i = originalTokens_i - COPIES * R - OVERHEAD` is the per-turn
 *     reduction in cached tokens (the original disappears; the replacement
 *     text remains in context COPIES times — call args + swapped result —
 *     plus a fixed OVERHEAD for the call block/ids/echo).
 *   - Over an expected remaining horizon H turns, replacing pays iff
 *     `S_i <= rho/(w - rho) * net_i * H`. Past that, expire.
 *
 * Prices are measured, not assumed: every turn's usage (verified against the
 * pi `Usage` shape — `{input, output, cacheRead, cacheWrite, cost}` on the
 * turn's assistant message) feeds an EMA of rho (cache-read price / uncached
 * input price) and w (cache-write price / uncached input price), starting at
 * config priors. Observations containing negative or non-finite numbers are
 * discarded whole — some routers log costs as negative token counts. When a
 * provider shows no cache activity for several consecutive turns the
 * pay-back model has nothing to say, so expiry freezes (phi = infinity).
 *
 * pileTotal — the steering ladder's total — is maintained here but never
 * modified by expiry: expired mass stays in the total until the next reset
 * (a replace call that stored something, or compaction), so expiry can
 * neither fire nor re-arm the ladder. Expiry is monotone: once expired,
 * an id is never re-armed in this change.
 *
 * This module is pure: it owns the expiry accounting over the shared
 * runtime state and exposes it as functions. No pi deps, no I/O — mirrors
 * the testable shape used by the rest of `lib/`.
 */

import type { PendingItem } from "./steering.ts";
import type { ToolclipRuntimeState, ToolclipRuntimeStateEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// Non-env constants.
// ---------------------------------------------------------------------------

/** EMA smoothing factor for the measured price ratios. */
export const PRICE_SMOOTHING_ALPHA = 0.3;

/** Minimum token count for a usage component to yield a valid price observation. */
export const OBSERVATION_FLOOR_TOKENS = 100;

/** Consecutive no-cache turns after which expiry freezes (phi = infinity). */
export const NO_CACHE_STREAK_THRESHOLD = 3;

/** Minimum request context size for a turn to count toward noCacheStreak. */
export const NO_CACHE_MIN_CTX_TOKENS = 2000;

/** Lower clamp for the assumed replacement size R. */
export const REPLACEMENT_CLAMP_MIN = 50;

/** Upper clamp for the assumed replacement size R. */
export const REPLACEMENT_CLAMP_MAX = 1000;

/** Maximum ids held in `expiredUnannounced` (bounds the nag's announce line). */
export const EXPIRED_ANNOUNCE_CAP = 20;

/** Default prior for rho (cache-read price / uncached input price). */
export const DEFAULT_EXPIRY_RHO = 0.2;

/** Default prior for w (cache-write price / uncached input price). */
export const DEFAULT_EXPIRY_WRITE_RATIO = 1.0;

/**
 * One turn's usage observation, extracted from the turn's assistant message
 * (see `extractTurnUsage` in src/toolclip.ts — pi-glue stays in src/).
 *
 * `ctxT` is the request context size of the turn: input + cacheRead +
 * cacheWrite. `cost` holds the billed prices when the provider reported
 * them; its fields are optional and individually untrusted (routers log
 * garbage — see the discard rule in `observeTurnUsage`).
 */
export interface TurnUsage {
	ctxT: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

/** Expiry knobs (from ToolclipConfig; priors excluded — they seed state). */
export interface ExpirySettings {
	replacementTokens: number;
	copies: number;
	overheadTokens: number;
	horizonMinTurns: number;
	horizonMaxTurns: number;
}

function clamp(value: number, lo: number, hi: number): number {
	return Math.min(Math.max(value, lo), hi);
}

function isFiniteNumber(n: number | undefined): n is number {
	return typeof n === "number" && Number.isFinite(n);
}

// ---------------------------------------------------------------------------
// Per-turn usage observation (turn_end step 1).
// ---------------------------------------------------------------------------

/**
 * Update the expiry accounting from one turn's usage: bump `turnsSeen`,
 * record `lastCtx`, EMA-update the measured prices, and maintain
 * `noCacheStreak`.
 *
 * Price observations: pIn/pCr/pCw are each valid only when their token
 * denominator is at least OBSERVATION_FLOOR_TOKENS and their cost numerator
 * is positive. Any observation (input/cacheRead/cacheWrite or their cost
 * fields) containing a negative or non-finite number is discarded whole —
 * no rho/w update that turn (some routers log costs as negative token
 * counts). `noCacheStreak` increments on a turn with no cache activity at
 * all (and a context of at least NO_CACHE_MIN_CTX_TOKENS — tiny requests
 * say nothing about cache behavior) and resets otherwise.
 */
export function observeTurnUsage(state: ToolclipRuntimeState, usage: TurnUsage): void {
	state.turnsSeen += 1;
	state.lastCtx = usage.ctxT;

	const raw = [usage.input, usage.cacheRead, usage.cacheWrite];
	const cost = usage.cost;
	const rawCosts = cost ? [cost.input, cost.cacheRead, cost.cacheWrite] : [];
	const garbage =
		raw.some((n) => !isFiniteNumber(n) || n < 0) ||
		rawCosts.some((n) => n !== undefined && (!isFiniteNumber(n) || n < 0));

	if (!garbage && cost) {
		const pIn =
			usage.input >= OBSERVATION_FLOOR_TOKENS && (cost.input ?? 0) > 0
				? cost.input! / usage.input
				: undefined;
		const pCr =
			usage.cacheRead >= OBSERVATION_FLOOR_TOKENS && (cost.cacheRead ?? 0) > 0
				? cost.cacheRead! / usage.cacheRead
				: undefined;
		const pCw =
			usage.cacheWrite >= OBSERVATION_FLOOR_TOKENS && (cost.cacheWrite ?? 0) > 0
				? cost.cacheWrite! / usage.cacheWrite
				: undefined;
		if (pIn !== undefined && pCr !== undefined) {
			const observed = clamp(pCr / pIn, 0.01, 1);
			state.rho += PRICE_SMOOTHING_ALPHA * (observed - state.rho);
		}
		if (pIn !== undefined && pCw !== undefined) {
			const observed = clamp(pCw / pIn, 1, 4);
			state.w += PRICE_SMOOTHING_ALPHA * (observed - state.w);
		}
	}

	if (usage.cacheRead === 0 && usage.cacheWrite === 0 && usage.ctxT >= NO_CACHE_MIN_CTX_TOKENS) {
		state.noCacheStreak += 1;
	} else {
		state.noCacheStreak = 0;
	}
}

// ---------------------------------------------------------------------------
// pileTotal maintenance (turn_end step 2, plus the replace-call reset).
// ---------------------------------------------------------------------------

/**
 * Whether an entry is currently tracked: pending (no replacement stored),
 * counted into pileTotal, and not expired. Expired entries are deleted from
 * the map, so the expiredIds check only matters for the (pathological)
 * re-record of an expired id — expiry is monotone and never re-arms.
 */
export function isTracked(
	state: ToolclipRuntimeState,
	id: string,
	entry: ToolclipRuntimeStateEntry,
): boolean {
	return (
		entry.replacement === undefined &&
		entry.counted &&
		!state.expiredIds.has(id)
	);
}

/**
 * Count newly eligible entries: pending entries whose id is in the most
 * recent context event's id set and that are not counted yet. At the moment
 * of counting: `counted = true`, `ctxSeen = ctxT`, and the entry's
 * originalTokens join `pileTotal`. Ids in `expiredIds` are skipped — expiry
 * is monotone, a re-marked expired id never comes back to life.
 *
 * Returns how many entries were newly counted.
 */
export function countNewlyEligible(state: ToolclipRuntimeState, ctxT: number): number {
	let added = 0;
	for (const [id, entry] of state.entries) {
		if (
			!entry.counted &&
			entry.replacement === undefined &&
			!state.expiredIds.has(id) &&
			state.lastContextToolCallIds.has(id)
		) {
			entry.counted = true;
			entry.ctxSeen = ctxT;
			state.pileTotal += entry.originalTokens;
			added += 1;
		}
	}
	return added;
}

/**
 * Recompute `pileTotal` as the sum of originalTokens over tracked entries.
 * The reset point for the total: it drops replaced, compacted and expired
 * mass in one sweep whenever a reset is due (see the callers — expiry alone
 * must never trigger it).
 */
export function recomputePileTotal(state: ToolclipRuntimeState): number {
	let total = 0;
	for (const [id, entry] of state.entries) {
		if (isTracked(state, id, entry)) {
			total += entry.originalTokens;
		}
	}
	state.pileTotal = total;
	return total;
}

/**
 * Compaction: remove counted, pending entries whose id is no longer in the
 * most recent context event's id set — they have been compacted out of the
 * model's messages and there is nothing left to replace. Replaced entries
 * are never touched (the context handler still swaps them). Entries marked
 * during the current turn are not counted yet and are never removed here.
 *
 * When anything was removed, `pileTotal` is recomputed over the remaining
 * tracked entries (this reset also drops expired mass — an intended side
 * effect of a reset, never of expiry itself). Returns whether entries were
 * removed.
 */
export function compactTracked(state: ToolclipRuntimeState): boolean {
	let removed = false;
	for (const [id, entry] of state.entries) {
		if (
			entry.counted &&
			entry.replacement === undefined &&
			!state.lastContextToolCallIds.has(id)
		) {
			state.entries.delete(id);
			removed = true;
		}
	}
	if (removed) {
		recomputePileTotal(state);
	}
	return removed;
}

/**
 * The reset applied right after a `replace_tool_result` call stored at
 * least one replacement: `pileTotal` becomes the sum over the remaining
 * tracked entries. (A call that stored nothing — all ids expired or
 * unknown — must not reset; the caller checks that.)
 */
export function resetPileTotalAfterStores(state: ToolclipRuntimeState): number {
	return recomputePileTotal(state);
}

// ---------------------------------------------------------------------------
// Replacement-size statistics.
// ---------------------------------------------------------------------------

/**
 * Record one stored replacement's size into the running mean. The mean is
 * used as R (the assumed replacement size) once at least 3 replacements
 * have been seen; before that the config prior is used.
 */
export function observeReplacement(state: ToolclipRuntimeState, replacementTokens: number): void {
	state.replCount += 1;
	state.replMeanTokens += (replacementTokens - state.replMeanTokens) / state.replCount;
}

// ---------------------------------------------------------------------------
// Expiry evaluation (turn_end step 3).
// ---------------------------------------------------------------------------

/**
 * Evaluate the expiry test over every tracked entry and delete the expired
 * ones. Per tracked entry i:
 *
 *   S_i   = max(0, ctxT - ctxSeen_i)        tokens appended since first sight
 *   R     = replMeanTokens if count >= 3 else the config prior; clamp [50, 1000]
 *   net_i = originalTokens_i - COPIES * R - OVERHEAD   saved per turn
 *   H     = clamp(turnsSeen, horizonMin, horizonMax)  expected remaining turns
 *   phi   = rho / (w - rho)   if w > rho, else infinity
 *   if noCacheStreak >= 3: phi = infinity
 *
 *   expire i  iff  net_i <= 0  OR  (phi finite AND S_i > phi * net_i * H)
 *
 * Expiry deletes the entry from `state.entries` (unreplaced entries only —
 * replaced entries must stay for the context swap), adds the id to
 * `expiredIds` and `expiredUnannounced` (the latter capped at 20 ids), and
 * thereby frees the stored original content. It NEVER modifies
 * `pileTotal` — that stays until the next reset (a storing replace call or
 * compaction). Expiry is monotone: expired ids are never re-armed.
 *
 * Returns the newly expired ids, in entry order.
 */
export function evaluateExpiry(
	state: ToolclipRuntimeState,
	ctxT: number,
	settings: ExpirySettings,
): string[] {
	const newlyExpired: string[] = [];
	for (const [id, entry] of state.entries) {
		if (!isTracked(state, id, entry)) {
			continue;
		}
		const seen = Math.max(0, ctxT - entry.ctxSeen);
		const R = clamp(
			state.replCount >= 3 ? state.replMeanTokens : settings.replacementTokens,
			REPLACEMENT_CLAMP_MIN,
			REPLACEMENT_CLAMP_MAX,
		);
		const net = entry.originalTokens - settings.copies * R - settings.overheadTokens;
		const horizon = clamp(state.turnsSeen, settings.horizonMinTurns, settings.horizonMaxTurns);
		const phi =
			state.noCacheStreak >= NO_CACHE_STREAK_THRESHOLD || !(state.w > state.rho)
				? Number.POSITIVE_INFINITY
				: state.rho / (state.w - state.rho);
		if (net <= 0 || (Number.isFinite(phi) && seen > phi * net * horizon)) {
			state.entries.delete(id);
			state.expiredIds.add(id);
			if (state.expiredUnannounced.size < EXPIRED_ANNOUNCE_CAP) {
				state.expiredUnannounced.add(id);
			}
			newlyExpired.push(id);
		}
	}
	return newlyExpired;
}

// ---------------------------------------------------------------------------
// Live tracked summary (the nag's data).
// ---------------------------------------------------------------------------

/**
 * Summarize the live tracked entries: tracked (pending, counted, not
 * expired) entries whose id is still in the most recent context event's id
 * set — ids in insertion order with their original estimated token counts,
 * plus their total T. This is what the nag reports: NOT `pileTotal`, which
 * may still carry expired mass until its next reset. Entries marked during
 * the current turn are not counted yet and are excluded; entries compacted
 * away are excluded.
 */
export function trackedSummary(state: ToolclipRuntimeState): {
	items: PendingItem[];
	totalTokens: number;
} {
	const items: PendingItem[] = [];
	let totalTokens = 0;
	for (const [id, entry] of state.entries) {
		if (isTracked(state, id, entry) && state.lastContextToolCallIds.has(id)) {
			items.push({ id, tokens: entry.originalTokens });
			totalTokens += entry.originalTokens;
		}
	}
	return { items, totalTokens };
}