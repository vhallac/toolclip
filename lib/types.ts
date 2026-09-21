/**
 * Toolclip configuration.
 *
 * `toolResultThresholdTokens`: minimum estimated token count for a tool
 * result to get a pending-replacement marker. Results at or below this
 * threshold are left untouched — they are too small for distillation to pay
 * off, so marking them only wastes a toolCallId and steering budget. The
 * max-replacement-ratio gate is intentionally NOT reintroduced:
 * replacements of any size are accepted (the hard-fail "replacement must be
 * strictly shorter than original" check was removed for observation and
 * stays removed).
 *
 * `quarantineThresholdTokens`: results above this (much higher) threshold
 * are not shown to the LLM at all — their content is swapped for a
 * quarantine notice and the payload is held in memory until read
 * ("held until read; freed after reading"), retrievable via
 * `read_quarantined_result`.
 */
export interface ToolclipConfig {
	/**
	 * Minimum estimated token count for a tool result to receive a pending
	 * marker. Results with fewer tokens are skipped entirely. Defaults to
	 * `1000`. Gated by `TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS`.
	 */
	toolResultThresholdTokens: number;
	/**
	 * Whether to inject steering reminders when the agent has left marked
	 * tool results un-replaced. Defaults to `true`. Gated by
	 * `TOOLCLIP_STEERING_REMINDER`.
	 */
	steeringReminder: boolean;
	/**
	 * First rung of the steering ladder (estimated tokens): the nag fires
	 * once the eligible pending mass strictly exceeds this, then at each
	 * higher Fibonacci rung (1.6×, 2.6×, 4.2×, 6.8×, ...). Defaults to
	 * `5000`. Gated by `TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS` — the env
	 * var's name predates the ladder and is kept; it now means "first
	 * rung", not a flat threshold.
	 */
	steeringFirstRungTokens: number;
	/**
	 * Whether oversized tool results are quarantined (content swapped for a
	 * notice, payload held until read). Defaults to `true`. Gated by
	 * `TOOLCLIP_QUARANTINE`.
	 */
	quarantine: boolean;
	/**
	 * Minimum estimated token count for a tool result to be quarantined:
	 * content swapped for a notice, payload held until read. Must be well
	 * above `toolResultThresholdTokens`. Defaults to `10000`. Gated by
	 * `TOOLCLIP_QUARANTINE_THRESHOLD_TOKENS`.
	 */
	quarantineThresholdTokens: number;
	/**
	 * Whether stale pending entries are expired (deleted from the tracker
	 * once replacing them no longer pays back; replace calls naming them
	 * are silently ignored). When false: no expiry — ladder-only, entries
	 * are kept until replaced or compacted away. Defaults to `true`. Gated
	 * by `TOOLCLIP_EXPIRY`.
	 */
	expiry: boolean;
	/**
	 * Prior for the cache-read price as a ratio of the uncached-input price.
	 * Replaced by the measured value via EMA once usage costs flow. Defaults
	 * to `0.2`. Gated by `TOOLCLIP_EXPIRY_RHO`.
	 */
	expiryRho: number;
	/**
	 * Prior for the cache-write price as a ratio of the uncached-input price
	 * (1.25 on Anthropic-style pricing). Defaults to `1.0`. Gated by
	 * `TOOLCLIP_EXPIRY_WRITE_RATIO`.
	 */
	expiryWriteRatio: number;
	/**
	 * Prior for the assumed replacement size (tokens) until 3 replacements
	 * have been measured. Defaults to `170`. Gated by
	 * `TOOLCLIP_EXPIRY_REPLACEMENT_TOKENS`.
	 */
	expiryReplacementTokens: number;
	/**
	 * How many copies of the replacement text sit in context: 2 in copy mode
	 * (args + swapped result both carry the text), 1 in pointer mode (the
	 * text lives once, in the replace call's args; the swapped result is a
	 * pointer). Defaults follow the mode: `1` in pointer mode, `2` in copy
	 * mode. Gated by `TOOLCLIP_EXPIRY_REPLACEMENT_COPIES` (an explicit env
	 * value always wins).
	 */
	expiryReplacementCopies: number;
	/**
	 * Fixed tokens per replacement not otherwise counted (call block, ids,
	 * echo). Defaults follow the mode: `95` in pointer mode (60 + ~35 for
	 * the pointer replacing the old replaced marker), `60` in copy mode.
	 * Gated by `TOOLCLIP_EXPIRY_OVERHEAD_TOKENS` (an explicit env value
	 * always wins).
	 */
	expiryOverheadTokens: number;
	/**
	 * Floor of H, the expected remaining turns in the expiry pay-back test.
	 * Defaults to `10`. Gated by `TOOLCLIP_EXPIRY_HORIZON_MIN_TURNS`.
	 */
	expiryHorizonMinTurns: number;
	/**
	 * Cap of H, the expected remaining turns in the expiry pay-back test.
	 * Defaults to `100`. Gated by `TOOLCLIP_EXPIRY_HORIZON_MAX_TURNS`.
	 */
	expiryHorizonMaxTurns: number;
	/**
	 * Whether newly expired ids are listed once in the next steering nag
	 * ("Expired (no longer worth replacing; leave them): ..."). Defaults to
	 * `true`. Gated by `TOOLCLIP_EXPIRY_ANNOUNCE`.
	 */
	expiryAnnounce: boolean;
	/**
	 * How a replaced original is presented on subsequent LLM calls.
	 *
	 * "pointer" (default): the replacement text is kept exactly ONCE in
	 * context — in the model's own replace call arguments, which are never
	 * modified — and the swapped original becomes a pointer naming that call
	 * and its receipt (see lib/receipt.ts). If the pointer's target call is
	 * no longer in the messages (compaction, a fork, another extension), the
	 * swap falls back to the copy form — a pointer must never dangle.
	 *
	 * "copy": today's behavior — the summary text is written in both places
	 * (the swapped result and the call args). Use for A/B runs.
	 *
	 * Gated by `TOOLCLIP_REPLACEMENT_MODE`.
	 */
	replacementMode: "pointer" | "copy";
	/**
	 * Whether the pointer text names the replace call's toolCallId. Some
	 * chat templates never show call ids to the model; the receipt is always
	 * included and is the reliable key. Defaults to `true`. Gated by
	 * `TOOLCLIP_POINTER_INCLUDE_CALL_ID`.
	 */
	pointerIncludeCallId: boolean;
	/** Prefix of the receipt id ("rp7k2-3" → prefix "rp"). Defaults to `"rp"`. Gated by `TOOLCLIP_RECEIPT_PREFIX`. */
	receiptPrefix: string;
	/**
	 * Random base36 characters in the receipt id, generated once per
	 * extension load so receipts stay unique after a resume (the counter
	 * restarts). `0` disables the tag. Defaults to `3`. Gated by
	 * `TOOLCLIP_RECEIPT_TAG_LENGTH`.
	 */
	receiptTagLength: number;
	/**
	 * Text stored in place of an empty or whitespace-only replacement — the
	 * model's way to say "the result was useless". The original is swapped
	 * in place for this text plus the replaced marker (no pointer, no
	 * receipt stamp: nothing was stored in the replace call's arguments),
	 * and a placeholder never feeds the expiry R (replMeanTokens). Defaults
	 * to `"tool result was not useful"`. Gated by
	 * `TOOLCLIP_EMPTY_REPLACEMENT_TEXT`.
	 */
	emptyReplacementText: string;
}

/**
 * One tracked tool result. Created when a (non-empty) tool result is
 * observed, mutated when the LLM calls `replace_tool_result` for it.
 *
 * `replacement` is the LLM-supplied replacement text. Until it is
 * set, the entry is "pending"; once set, the context-event handler will
 * swap the original out on subsequent LLM calls.
 *
 * `grew` is set when a replacement is recorded whose estimated token count is
 * >= the original's — the observation target. No rejection happens; this is
 * purely diagnostic.
 *
 * `counted`/`ctxSeen` drive the expiry accounting (see lib/expiry.ts): an
 * entry becomes COUNTED at the first turn_end where it is pending and its id
 * is in the most recent context event's id set; at that moment `ctxSeen`
 * records the request context size (ctx_t) of that turn, so the tokens
 * appended since (S_i = ctx_t - ctxSeen) can be compared against the
 * pay-back threshold later. `pileTotal` accumulates the entry's
 * `originalTokens` at the same moment.
 *
 * `replaceCallId`/`receiptId` (pointer mode) name the `replace_tool_result`
 * call whose arguments carry the replacement text and the receipt id minted
 * for that call (see lib/receipt.ts). Stamped on every entry the call
 * stored; a re-replacement overwrites both — the pointer then names the
 * newest call. Only read by the pointer-mode context swap; recorded in
 * every mode so the state shape does not depend on the mode.
 */
export interface ToolclipRuntimeStateEntry {
	originalTokens: number;
	originalContent: string;
	replacement?: string;
	replacementTokens?: number;
	grew?: boolean;
	/** True once the entry has been counted into `pileTotal`. */
	counted: boolean;
	/** Request context size (ctx_t) at the turn_end where the entry was counted. 0 until counted. */
	ctxSeen: number;
	/** The replace call's own toolCallId whose arguments carry the replacement text. */
	replaceCallId?: string;
	/** Receipt id minted for that storing call (see lib/receipt.ts). */
	receiptId?: string;
}

/**
 * One held (quarantined) tool-result payload. Created when a result over
 * the quarantine threshold is observed; removed when the LLM reads it
 * (released). There is no eviction — payloads are held for the session's
 * lifetime ("held until read; freed after reading"): the session file
 * holds only the notice, so the in-memory payload is the only copy, and
 * evicting it was permanent data destruction (the 2026-09-20 golden run's
 * one-turn window destroyed exactly the one payload the model needed).
 *
 * `createdTurn` is the turn index (pi's `turn_start`/`turn_end` counter)
 * during which the result was quarantined. The LLM first sees the notice
 * in the NEXT turn (`createdTurn + 1`) because pi delivers a turn's tool
 * results at that turn's `turn_end` — but the notice starts no countdown:
 * a read attempt is honored at any later turn. Kept for diagnostics.
 */
export interface QuarantineEntry {
	payload: string;
	tokens: number;
	createdTurn: number;
}

/**
 * Runtime state for the extension. Pure — callers pass the state object in.
 *
 * `entries` tracks replaceable tool results (keyed by tool-call id).
 * `quarantines` tracks held payloads awaiting a read (session lifetime).
 * `releasedQuarantines` remembers ids whose payloads were already read
 * (released), so a denied read attempt can say "already read" instead of
 * "never held" — the latter usually means the model mistook a pending
 * marker for a quarantine notice, and the denial then points it at the
 * distillation path instead.
 * `currentTurn` mirrors pi's turn index, maintained via `turn_start`.
 * `lastContextToolCallIds` holds the tool-call ids present in the messages
 * of the most recent `context` event — recorded each time the context
 * event fires (state only; the handler still returns the same swapped
 * messages). Steering eligibility is defined against this set: a pending
 * entry is eligible while its id is in the messages the model most
 * recently saw. A result marked during the current turn is not yet in the
 * last context event, so it is not eligible until the model has had one
 * response to act on it; entries compacted away are no longer in the
 * messages, so they stop counting.
 * `readsThisRound` counts successful read results per path within the
 * current round (re-read observation; reset at each round boundary).
 *
 * Expiry accounting (lib/expiry.ts):
 * `pileTotal` is the steering ladder's total — the sum of originalTokens over
 * *tracked* entries (pending, counted, not expired). It is maintained by three
 * resets: entry counting (+= originalTokens), a replace call that stored at
 * least one replacement (recomputed), and compaction (recomputed when entries
 * were removed). Expiry itself never modifies it — expired mass stays in the
 * total until the next reset, so expiry can neither fire nor re-arm the ladder.
 * `turnsSeen` counts turn_end events since the extension loaded (not reset per
 * round); `lastCtx` is the request context size of the most recent usable turn.
 * `rho`/`w` are running price estimates (cache-read / cache-write price as a
 * ratio of the uncached-input price), EMA-updated from per-turn usage costs;
 * they start at the config priors. `noCacheStreak` counts consecutive usable
 * turns with no cache activity (three or more freeze expiry — with no cache
 * there is no pay-back to model). `replMeanTokens`/`replCount` track the mean
 * stored replacement size (used as R once 3 replacements are seen).
 * `expiredIds` remembers expired ids forever (expiry is monotone; a replace
 * call naming one is silently ignored); `expiredUnannounced` holds ids expired
 * since the last nag that listed them (capped at 20).
 */
export interface ToolclipRuntimeState {
	entries: Map<string, ToolclipRuntimeStateEntry>;
	quarantines: Map<string, QuarantineEntry>;
	releasedQuarantines: Set<string>;
	currentTurn: number;
	lastContextToolCallIds: Set<string>;
	readsThisRound: Map<string, number>;
	/** The steering ladder's total: sum of originalTokens over tracked entries. */
	pileTotal: number;
	/** turn_end events observed since the extension loaded (not reset per round). */
	turnsSeen: number;
	/** Request context size (input + cacheRead + cacheWrite) of the most recent usable turn. */
	lastCtx: number;
	/** Running cache-read price ratio (cacheRead price / uncached input price). */
	rho: number;
	/** Running cache-write price ratio (cacheWrite price / uncached input price). */
	w: number;
	/** Consecutive usable turns with no cache activity (cacheRead == 0 && cacheWrite == 0). */
	noCacheStreak: number;
	/** Running mean of replacementTokens over stored replacements. */
	replMeanTokens: number;
	/** How many stored replacements the mean is over. */
	replCount: number;
	/** Ids whose pending entries were expired (never re-armed). */
	expiredIds: Set<string>;
	/** Ids expired since the last nag that listed them (capped at 20). */
	expiredUnannounced: Set<string>;
}
