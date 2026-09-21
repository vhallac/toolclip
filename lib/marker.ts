/**
 * Marker builder for toolclip.
 *
 * Three markers are used:
 *
 * 1. PENDING — appended to the LLM-facing content of a tool result whose
 *    estimated token count is above `TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS`.
 *    Tells the LLM it may call `replace_tool_result(id, replacement)` to swap
 *    the bulky original for a tight replacement in subsequent turns.
 *
 *    Format:
 *      [tool-result-pending-replacement: toolCallId=<id>, tokens=<N>]
 *
 * 2. REPLACED — appended after a successful replacement, on the swapped
 *    content. Keeps traceability: even after the original is gone, the
 *    LLM (and logs) can tell which id was replaced.
 *
 *    Format:
 *      [tool-result-replaced: toolCallId=<id>]
 *
 * 2b. POINTER — the pointer-mode replacement of the whole swapped content:
 *    one text block naming the replace call whose (unmodified) arguments
 *    carry the replacement text and the receipt minted for it. Shares the
 *    REPLACED prefix, so greps for it still find pointers.
 *
 *    Format (includeCallId true):
 *      [tool-result-replaced: toolCallId=<id>; summary is the replacement
 *       text for this id in your replace_tool_result call <callId>, receipt <rid>]
 *    (includeCallId false drops the call id after "call".)
 *
 * 3. (parsing helper) `parsePendingMarker(text)` walks an arbitrary text
 *    blob, finds the first PENDING marker (if any), and returns
 *    `{ toolCallId, tokens }` or `null`. Strict: malformed markers are
 *    silently treated as not-present.
 */

const PENDING_PREFIX = "[tool-result-pending-replacement:";
const PENDING_SUFFIX = "]";
const REPLACED_PREFIX = "[tool-result-replaced:";
const REPLACED_SUFFIX = "]";
const QUARANTINED_PREFIX = "[tool-result-quarantined:";
const QUARANTINED_SUFFIX = "]";
const MISSED_PREFIX = "[quarantine-missed:";
const MISSED_SUFFIX = "]";

/**
 * Build the pending-replacement marker.
 *
 * @param toolCallId - The tool call id whose result is over the threshold.
 * @param tokens - The estimated token count of the original result.
 * @returns The marker string, e.g.
 *          `[tool-result-pending-replacement: toolCallId=abc, tokens=512]`.
 */
export function buildPendingMarker(toolCallId: string, tokens: number): string {
	return `${PENDING_PREFIX} toolCallId=${toolCallId}, tokens=${tokens}${PENDING_SUFFIX}`;
}

/**
 * Build the replaced marker.
 *
 * @param toolCallId - The tool call id whose result was replaced.
 * @returns The marker string, e.g. `[tool-result-replaced: toolCallId=abc]`.
 */
export function buildReplacedMarker(toolCallId: string): string {
	return `${REPLACED_PREFIX} toolCallId=${toolCallId}${REPLACED_SUFFIX}`;
}

/**
 * Build the pointer text swapped into a replaced original in pointer mode.
 *
 * The replacement text is kept exactly once — in the arguments of the
 * model's own `replace_tool_result` call, which are never modified — and
 * this pointer names that call (optionally, see below) and the receipt
 * minted for it, so the model can read the replacement from its own call
 * instead of needing a second copy in the result slot.
 *
 * The prefix `[tool-result-replaced: toolCallId=<id>` is kept identical to
 * `buildReplacedMarker`'s output so traceability greps and tests that
 * match the replaced-marker prefix keep working for pointer text too.
 *
 * Deterministic: depends only on the stored state passed in.
 *
 * @param toolCallId - The replaced original result's id.
 * @param replaceCallId - The replace call's own toolCallId whose arguments
 *   carry the replacement text.
 * @param receiptId - The receipt minted for that call (always present —
 *   the reliable key when chat templates hide call ids).
 * @param includeCallId - Include the replace call's toolCallId after
 *   "call"; false drops it (receipt only).
 */
export function buildReplacedPointer(
	toolCallId: string,
	replaceCallId: string,
	receiptId: string,
	includeCallId: boolean,
): string {
	const callPart = includeCallId ? ` ${replaceCallId}` : "";
	return (
		`${REPLACED_PREFIX} toolCallId=${toolCallId}; ` +
		"summary is the replacement text for this id in your replace_tool_result" +
		` call${callPart}, receipt ${receiptId}${REPLACED_SUFFIX}`
	);
}

/**
 * Build the quarantined marker (the notice swapped into an oversized tool
 * result's content in place of the payload).
 *
 * @param toolCallId - The tool call id whose result was quarantined.
 * @param tokens - The estimated token count of the held payload.
 * @returns The marker string, e.g.
 *          `[tool-result-quarantined: toolCallId=abc, tokens=12000]`.
 */
export function buildQuarantinedMarker(toolCallId: string, tokens: number): string {
	return `${QUARANTINED_PREFIX} toolCallId=${toolCallId}, tokens=${tokens}${QUARANTINED_SUFFIX}`;
}

/**
 * Build the quarantine-missed marker, returned to the LLM when a
 * `read_quarantined_result` call targets an id that is not held (already
 * read and released, or never quarantined).
 *
 * @param toolCallId - The id that was requested.
 * @returns The marker string, e.g.
 *          `[quarantine-missed: toolCallId=abc]`.
 */
export function buildQuarantineMissedMarker(toolCallId: string): string {
	return `${MISSED_PREFIX} toolCallId=${toolCallId}${MISSED_SUFFIX}`;
}

interface ParsedPendingMarker {
	toolCallId: string;
	tokens: number;
}

/**
 * Find the first pending marker in `text` and parse it.
 *
 * The marker may appear anywhere in the string — appended to the end of a
 * tool result, in the middle, etc. The function returns the first match
 * or `null` if there is none / it is malformed.
 *
 * @param text - Any text blob to scan.
 * @returns The parsed `{ toolCallId, tokens }` or `null`.
 */
export function parsePendingMarker(text: string): ParsedPendingMarker | null {
	if (typeof text !== "string" || text.length === 0) {
		return null;
	}

	const start = text.indexOf(PENDING_PREFIX);
	if (start === -1) {
		return null;
	}

	const closeOffset = text.indexOf(PENDING_SUFFIX, start + PENDING_PREFIX.length);
	if (closeOffset === -1) {
		return null;
	}

	const body = text
		.slice(start + PENDING_PREFIX.length, closeOffset)
		.trim();

	const idMatch = body.match(/^toolCallId=([^\s,]+)\s*,\s*tokens=(\d+)$/);
	if (!idMatch) {
		return null;
	}

	const toolCallId = idMatch[1];
	const tokens = Number(idMatch[2]);
	if (!Number.isFinite(tokens) || tokens < 0 || !Number.isInteger(tokens)) {
		return null;
	}

	return { toolCallId, tokens };
}