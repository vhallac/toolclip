/**
 * Receipt minting for toolclip's pointer mode.
 *
 * In pointer mode the replacement text lives exactly once in context — in
 * the arguments of the model's own `replace_tool_result` call, which are
 * never modified. The swapped original becomes a pointer to it, keyed by a
 * **receipt id**: a short, per-call identifier stamped both on the echo
 * ("Receipt rp7k2-1: stored 2 replacement(s) (call call_A). ...") and on
 * every original result this call replaced. The model resolves a pointer by
 * finding its own call whose result carries the same receipt — the receipt
 * is the reliable key, because some chat templates never show call ids.
 *
 * Format: `PREFIX + sessionTag + "-" + counter` (e.g. "rp7k2-3"). The
 * session tag is random base36, generated once per extension load and never
 * persisted: after a resume the extension state is empty (no swaps happen
 * for pre-resume entries), but the earlier echoes in the session history
 * still display receipts from the previous load, and the counter restarts
 * at 0 — the fresh tag keeps the new receipts from colliding with those
 * stale echoes. A tag length of 0 disables the tag ("rp-3").
 *
 * The counter increments only when a call actually stored at least one
 * replacement; a call that stored nothing (all ids expired or unknown)
 * gets no receipt and leaves the counter untouched.
 */

export interface ReceiptState {
	/** Random base36 tag generated once at extension load ("" when disabled). */
	sessionTag: string;
	/** Receipts minted so far this load; starts at 0, incremented per storing call. */
	counter: number;
}

/**
 * Generate a random base36 tag of the requested length (characters 0-9a-z).
 * Length 0 (or less) yields the empty string — the tag is disabled.
 */
export function randomBase36Tag(length: number): string {
	if (length <= 0) {
		return "";
	}
	let tag = "";
	for (let i = 0; i < length; i++) {
		tag += Math.floor(Math.random() * 36).toString(36);
	}
	return tag;
}

/** Create a fresh receipt state with a freshly drawn session tag. */
export function createReceiptState(tagLength: number): ReceiptState {
	return { sessionTag: randomBase36Tag(tagLength), counter: 0 };
}

/**
 * Format a receipt id: `prefix + sessionTag + "-" + counter`. With the tag
 * disabled (empty session tag) the id is `prefix + "-" + counter`.
 */
export function formatReceiptId(
	prefix: string,
	sessionTag: string,
	counter: number,
): string {
	return `${prefix}${sessionTag}-${counter}`;
}

/**
 * Mint the receipt for a replace call that stored at least one item:
 * increments the counter and returns the formatted receipt id. Exactly one
 * mint per storing call — all items stored by the call share it.
 */
export function mintReceipt(state: ReceiptState, prefix: string): string {
	state.counter += 1;
	return formatReceiptId(prefix, state.sessionTag, state.counter);
}