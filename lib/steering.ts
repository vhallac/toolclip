/**
 * Steering reminder for toolclip.
 *
 * The failure mode this targets: the agent sees `[tool-result-pending-replacement]`
 * markers but never circles back to call `replace_tool_result` — it *collects*
 * pending replacements, deferring "until I need this" and then never does.
 *
 * Single trigger: the **pending mass** — `pileTotal` in the runtime state,
 * maintained by lib/expiry.ts as the sum of original estimated tokens over
 * *tracked* entries (pending, counted, not expired) — against one Fibonacci
 * ladder of rungs. Eligibility is decided by expiry's counting rule against
 * the id set recorded from the most recent `context` event; it gives the
 * rule two wanted behaviors for free:
 *
 * - A result marked during the current turn is not yet in the last
 *   `context` event's messages, so it is not eligible until the model has
 *   had one response to act on it.
 * - Results compacted away are no longer in the messages, so they stop
 *   counting — the pile tracks what the model actually still carries.
 *
 * The ladder: rung(k) = round(first * F(k) / 5) with F(1) = 5, F(2) = 8,
 * F(k+1) = F(k) + F(k-1) — firstRung, 1.6×, 2.6×, 4.2×, 6.8×, ... (5000,
 * 8000, 13000, 21000, 34000, 55000, 89000, ... at the default first rung;
 * 10000, 16000, 26000, 42000, 68000, ... with firstRung = 10000). The
 * geometric growth keeps the nag cadence sparse exactly where nags are
 * cheap (small piles self-correct with one batched call) while guaranteeing
 * a nag for any pile size — the earlier pair of flat thresholds needed two
 * triggers (count + size) with independent latches to cover both the
 * many-small-items and the single-huge-blob failure shapes; one
 * size-only ladder covers both, because both shapes are just mass.
 *
 * Ratchet state: one integer `level` — the number of rungs already
 * announced. At every `turn_end`, after pileTotal is updated (counting,
 * compaction, expiry — none of which the ladder sees; it reads the total as
 * it stands):
 *
 *   c = crossedRungs(pileTotal)  // rungs strictly below the total
 *   if c < level: level = c      // re-arm; the total only falls via replacement or compaction
 *   if c > level: fire ONE nag; level = c
 *
 * Comparison is strict (S == a rung does not cross it) and a multi-rung
 * jump announces only one nag — the pile just got bigger, and the message
 * already lists every eligible id; repeating per rung would only add
 * identical nags to the same boundary. When the pile shrinks through a
 * level, the level re-arms down, so a re-grown pile is nagged again.
 *
 * Round boundary: `level` resets to 0 at each round boundary (in
 * `before_agent_start`) so a pile persisting into a new round is
 * re-announced at that round's first turn boundary.
 *
 * Delivery: pi-native steering. On a fire the caller enqueues the
 * reminder via `api.sendUserMessage(text, { deliverAs: "steer" })` — pi's
 * real steering path. The message is queued on the agent's steering queue,
 * drained at the next turn boundary, and PERSISTED as a real user message
 * in the session: it becomes part of the session's message list, is visible
 * in every subsequent LLM call, and is included in compaction and
 * summarization. That persistence is the point — a nag that flashes for a
 * single LLM call (a synthetic append in the `context` handler) is
 * structurally incapable of nagging: the post-fix golden run of 2026-09-20
 * showed the pile above the rungs for 119 consecutive calls while the
 * model saw each nag exactly once.
 *
 * Observation point: `turn_end`, after the turn's tool results are in and
 * replacements recorded — the freshest *eligible* pile state the boundary
 * can see. The agent loop polls the steering queue immediately after
 * `turn_end`, so a steer enqueued there is delivered at that same
 * boundary: visible from the very next LLM call onward. Two consequences
 * of the native path: a pile above the announced rungs at a run's final
 * turn forces one more turn (the model must at least see the nag), and the
 * message text is computed at observation time — ids and totals can be
 * mildly stale if a later turn changes the pile before the message is read
 * (subsequent observations still fire on correct data).
 *
 * This module is pure: it owns the per-round steering state and exposes the
 * ladder, the eligibility decision plus the message builder. No pi deps,
 * no I/O — mirrors the testable shape used by the rest of `lib/`.
 */

/**
 * Per-round steering ratchet state. Reset at each round boundary (in
 * `before_agent_start`) so a pile persisting into a new round is
 * re-announced at that round's first turn boundary.
 *
 * `level` is the number of ladder rungs already announced for the current
 * round: a fire happens only when `crossed(S)` exceeds it, and it re-arms
 * down whenever the crossed count falls below it.
 */
export interface SteeringState {
	/** Rungs already announced (crossed count at the last fire). */
	level: number;
}

/** Options for the steering eligibility decision (from `ToolclipConfig`). */
export interface SteeringOptions {
	/**
	 * First ladder rung (estimated tokens): the nag fires once the pending
	 * mass strictly exceeds this, then at each higher Fibonacci rung.
	 */
	firstRungTokens: number;
	/** Master switch; when false nothing fires and no level is tracked. */
	enabled: boolean;
}

/** The decision of one steering observation: whether a nag should fire. */
export interface SteeringDecision {
	fire: boolean;
}

/** One un-replaced pending result: its id and original estimated tokens. */
export interface PendingItem {
	id: string;
	tokens: number;
}

/**
 * Create fresh steering state for a new round.
 */
export function createSteeringState(): SteeringState {
	return { level: 0 };
}

/**
 * Reset steering state for a new round. Same shape as `createSteeringState`
 * but mutates in place — used by the round-boundary handler so the same state
 * object survives across rounds without re-allocation.
 */
export function resetSteering(state: SteeringState): void {
	state.level = 0;
}

/**
 * Count the ladder rungs strictly below `totalTokens` — the number of rungs
 * the pending mass has crossed.
 *
 * Rungs: rung(k) = round(firstRung * F(k) / 5) with F(1) = 5, F(2) = 8,
 * F(k+1) = F(k) + F(k-1) — firstRung, 1.6×firstRung, 2.6×, 4.2×, 6.8×,
 * 11×, ... (5000, 8000, 13000, 21000, 34000, 55000, 89000, ... at the
 * default; 10000, 16000, 26000, 42000, 68000, ... with firstRung = 10000).
 * Comparison is strict: `totalTokens == rung` does not cross it. Rungs are
 * generated by iteration until one reaches `totalTokens`, so the function
 * terminates for any mass.
 */
export function crossedRungs(totalTokens: number, firstRung: number): number {
	let crossed = 0;
	// F(1) = 5: rung(1) is firstRung itself.
	if (firstRung < totalTokens) {
		crossed = 1;
	} else {
		return 0;
	}
	let fPrev = 5; // F(k-1) once k >= 2
	let f = 8; // F(2)
	for (;;) {
		const rung = Math.round((firstRung * f) / 5);
		if (rung >= totalTokens) {
			return crossed;
		}
		crossed += 1;
		const next = fPrev + f;
		fPrev = f;
		f = next;
	}
}

/**
 * Apply the steering ratchet to a pending-mass observation (the caller
 * observes from `turn_end`, after the turn's tool results are in — one
 * observation per turn).
 *
 * `state.level` is the number of rungs already announced. When the crossed
 * count rises above it, ONE nag fires (even if several rungs were crossed
 * at once) and the level is raised to the crossed count; when the crossed
 * count falls below it — the mass only falls via replacements or
 * compaction — the level re-arms down so a re-grown pile is nagged again.
 * When steering is disabled, nothing fires and no level is tracked.
 */
export function observePendingSteering(
	state: SteeringState,
	totalTokens: number,
	options: SteeringOptions,
): SteeringDecision {
	if (!options.enabled) {
		return { fire: false };
	}
	const crossed = crossedRungs(totalTokens, options.firstRungTokens);
	if (crossed < state.level) {
		// Re-arm: the pile shrank below an announced rung (replacements or
		// compaction), so re-announce if it re-grows.
		state.level = crossed;
	}
	if (crossed > state.level) {
		// One nag per multi-rung jump; the level catches up in full.
		state.level = crossed;
		return { fire: true };
	}
	return { fire: false };
}

/**
 * Build the steering reminder text: a count and total-size summary, the
 * extract-then-replace method, the anti-hoarding rule ("do not save for just
 * in case"), and the explicit list of pending ids with their sizes so the
 * agent can act on them directly in a single batched `replace_tool_result`
 * call — and can see at a glance which single item is hogging the pile.
 * Kept short and imperative.
 *
 * When expiry has removed entries since the last nag that listed them
 * (`expiredIds` non-empty), one trailing line tells the model those results
 * are no longer worth replacing and to leave them alone — without it, a
 * model working from an older nag's id list would burn calls on ids the
 * pay-back model has already written off (the calls would be silently
 * ignored, but silence invites retries).
 *
 * @param count - How many live tracked results are still un-replaced.
 * @param totalTokens - Total estimated tokens across the live tracked pile.
 * @param items - The live tracked pending items (id + estimated tokens), in
 *   reported order.
 * @param expiredIds - Ids expired since the last nag that listed them, when
 *   announce is on; omitted (or empty) for no line.
 */
export function buildSteeringMessage(
	count: number,
	totalTokens: number,
	items: PendingItem[],
	expiredIds?: string[],
): string {
	const lines = [
		`Steering: you have ${count} tool-result-pending-replacements totalling ~${totalTokens} estimated tokens — ` +
			`consider distilling their results. ` +
			`Extract ALL information you may still need from each into its replacement and replace them now, ` +
			`in a single replace_tool_result call. Do not save a result for just in case: ` +
			`anything you might need later belongs inside its replacement, and an un-replaced original ` +
			`keeps costing full context on every call.`,
	];
	for (const item of items) {
		lines.push(`- ${item.id} (~${item.tokens} tokens)`);
	}
	if (expiredIds && expiredIds.length > 0) {
		lines.push(`Expired (no longer worth replacing; leave them): ${expiredIds.join(", ")}`);
	}
	return lines.join("\n");
}