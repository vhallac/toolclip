/**
 * Same-path re-read observation for toolclip.
 *
 * The failure mode this observes (live pro golden run, 2026-09-20): the agent
 * replaces a tool result and then re-reads the same file soon after — the
 * distill-refetch loop. In that run roughly 40% of tool calls were loop
 * overhead (13 replacements + ~10 redundant full reads of the same files),
 * and the re-reads were NOT always consecutive — so consecutive-pair
 * detection is not enough. The hook counts successful `read` results per
 * path within the round and exposes the count in the read result's
 * `details` (same spirit as the `grew` flag on replacements) whenever the
 * count reaches 2+. Run analysis can then flag the loop directly, including
 * re-reads that are separated by other calls.
 *
 * Purely observational: the LLM-facing content is never modified, and cache
 * behavior is unchanged. Pure functions over a Map; no I/O, no pi deps.
 */

/**
 * Per-round re-read tracker: path → number of successful read results
 * observed so far in the current round. Reset at each round boundary.
 */
export type RereadTracker = Map<string, number>;

/**
 * Record one successful read of `path` within the current round.
 * Returns the cumulative count (1 = first read, 2+ = re-read).
 */
export function observeRead(tracker: RereadTracker, path: string): number {
	const count = (tracker.get(path) ?? 0) + 1;
	tracker.set(path, count);
	return count;
}

/**
 * Details payload attached to a read result whose path has already been read
 * this round. Nested under a `toolclipReread` key so it cannot collide with
 * the read tool's own details (e.g. truncation info).
 */
export interface RereadDetails {
	toolclipReread: {
		/** The path that was read again. */
		path: string;
		/** How many times this path has been read in the current round (2+). */
		count: number;
	};
}

/**
 * Build the details payload for a read result. `undefined` for first reads
 * (count < 2) — the caller then leaves the result's details untouched.
 */
export function buildRereadDetails(
	path: string,
	count: number,
): RereadDetails | undefined {
	if (count < 2) {
		return undefined;
	}
	return { toolclipReread: { path, count } };
}

/**
 * Reset the per-round tracker. Called at each round boundary
 * (`before_agent_start`) alongside the steering and quarantine resets.
 */
export function resetRereads(tracker: RereadTracker): void {
	tracker.clear();
}