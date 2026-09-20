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
 * `read_quarantined_result` call targets an id that is no longer held
 * (already read, or its one-turn window expired).
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