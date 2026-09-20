/**
 * toolclip — Targeted context reduction for individual tool results.
 *
 * Listens to the `tool_result` event; appends a pending-replacement marker
 * to the LLM-facing content of every non-empty text tool result. Registers
 * `replace_tool_result(items)` so the LLM can swap bulky originals for tight
 * replacements in subsequent turns. `items` is an array of
 * `{toolCallId, replacement}` pairs, so a single call can replace many
 * results at once.
 *
 * The `tool_result` handler skips its own tool (`replace_tool_result`):
 * without that guard, every replacement call's own result text
 * ("Replacement stored for …") would get a pending marker, inducing a
 * self-replacement loop where the LLM dutifully re-replaces its own
 * replacement results — burning tokens for no gain.
 *
 * Size gate: only tool results strictly above `toolResultThresholdTokens`
 * (default 1000) get a pending marker — distillation does not pay off for
 * small results, so marking them only wastes a toolCallId and steering
 * budget. The max-replacement-ratio gate stays removed: replacements of any
 * size are accepted, and the tool records a `grew` flag when a replacement
 * is at least as large as its original — the observation target for
 * reintroducing a length gate later.
 *
 * Quarantine: results above the much higher `quarantineThresholdTokens`
 * (default 10000) are withheld from the LLM entirely — content swapped for
 * a `[tool-result-quarantined: ...]` notice, payload held for exactly one
 * turn ("use it or lose it"), retrievable via the registered
 * `read_quarantined_result` tool. The read's own result re-enters the
 * normal pending-marker path (it is replaceable), never re-quarantined —
 * that would be a loop. Both the notice and the system-prompt section tell
 * the model to read the held payload in full when it needs all of it —
 * never to reconstruct it piecemeal with several narrowed calls.
 *
 * Re-read observation: successful `read` results are counted per path
 * within the round; when a path is read more than once (the
 * distill-refetch loop — replacements are irreversible, so re-deriving a
 * dropped detail means a fresh full-price read), the result's `details`
 * carry a `toolclipReread` entry, same spirit as the `grew` flag. Purely
 * diagnostic: LLM-facing content and cache behavior are untouched, and
 * re-reads that are not consecutive are still flagged (per-round count).
 *
 * The `context` event does the actual swap before each LLM call.
 *
 * The LLM is the only actor. There is no auto-summarizer and no auto-eviction.
 */

import type {
	ExtensionAPI,
	ToolResultEvent,
	ContextEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	AgentToolResult,
	ExtensionContext,
	AgentToolUpdateCallback,
	TurnStartEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { loadToolclipConfig } from "../lib/toolclip-config.ts";
import { createRuntimeState } from "../lib/runtime-state.ts";
import { estimateTokens } from "../lib/tokens.ts";
import { buildPendingMarker, buildReplacedMarker } from "../lib/marker.ts";
import {
	recordQuarantine,
	releaseQuarantine,
	evictExpiredQuarantines,
	buildQuarantineNotice,
	buildQuarantineMissedNotice,
	clearQuarantines,
} from "../lib/quarantine.ts";
import {
	createSteeringState,
	resetSteering,
	unreplacedPendingIds,
	observePendingBand,
	buildSteeringMessage,
} from "../lib/steering.ts";
import {
	recordPending,
	recordReplacement,
	getReplacement,
} from "../lib/runtime-state.ts";
import {
	observeRead,
	buildRereadDetails,
	resetRereads,
} from "../lib/rereads.ts";
import type { RereadDetails } from "../lib/rereads.ts";
import type { ToolclipRuntimeState } from "../lib/types.ts";

/**
 * Estimate the total text length of a tool result's content array.
 *
 * Content is `(TextContent | ImageContent)[]`. Only text blocks contribute
 * to the token estimate. Image blocks contribute their description text
 * (if any) plus a fixed overhead representing the base64 data.
 */
function estimateToolResultTokens(content: ToolResultEvent["content"]): number {
	let total = 0;
	for (const block of content) {
		if (block.type === "text") {
			total += estimateTokens(block.text);
		}
	}
	return total;
}

/**
 * Produce a single flat text representation of the content array.
 *
 * Preserves text blocks in order, joined by newlines. Image blocks are
 * replaced with their mimeType+data length so the LLM still sees the
 * original structure when the marker appears.
 *
 * This is used only for the token estimate and for storing the "original
 * content" in runtime state (for diagnostics). The actual LLM-facing
 * content always has the original content array with the marker appended.
 */
function flattenContent(content: ToolResultEvent["content"]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push(`[image: ${block.mimeType}, ${block.data.length} bytes]`);
		}
	}
	return parts.join("\n");
}

/**
 * Merge the re-read observation payload into a tool result's details.
 *
 * The runner REPLACES (does not merge) a handler-returned `details`, so the
 * tool's own details (e.g. the read tool's truncation info) must be carried
 * through. Returns `undefined` when there is nothing to attach — the caller
 * then leaves the result's details untouched.
 */
function withRereadDetails(
	base: unknown,
	reread: RereadDetails | undefined,
): Record<string, unknown> | undefined {
	if (reread === undefined) {
		return undefined;
	}
	const baseObj =
		base !== null && typeof base === "object"
			? (base as Record<string, unknown>)
			: {};
	return { ...baseObj, ...reread };
}

export default function toolclip(api: ExtensionAPI): void {
	const config = loadToolclipConfig();
	const state: ToolclipRuntimeState = createRuntimeState();
	const steering = createSteeringState();

	// -----------------------------------------------------------------------
	// 1. tool_result event handler
	//
	//    Four outcomes, in order:
	//    a. replace_tool_result results — skipped (self-replacement loop).
	//    b. read_quarantined_result results — never re-quarantined (that
	//       would be a loop); they fall through the normal pending-marker
	//       path so the freshly-returned payload is replaceable.
	//    c. everything else — quarantined above the quarantine threshold
	//       (payload withheld), pending-marked above the pending threshold,
	//       untouched below it.
	//    Every successful `read` is additionally counted per path for the
	//    re-read observation; from the second read of a path in a round, a
	//    `toolclipReread` entry is merged into the result's details.
	// -----------------------------------------------------------------------
	api.on("tool_result", (event: ToolResultEvent) => {
		// Guard against the self-replacement loop: the result of a
		// `replace_tool_result` call itself ("Replacement stored for …") must
		// NOT get a pending marker. Without this, every replacement call's own
		// result becomes a new pending entry, and the LLM is nudged to replace
		// its own replacement results — a converging-but-wasteful loop. The
		// tool's own output is short by construction and is never something to
		// distill.
		if (event.toolName === "replace_tool_result") {
			return;
		}

		// Re-read observation hook: count successful reads per path within the
		// round. Failed reads (isError) are not counted — the diagnostic target
		// is the distill-refetch loop, which re-fetches successfully. `input`
		// is optional-chained defensively: the pi contract always carries it,
		// but a malformed event must not take the handler down.
		let reread: RereadDetails | undefined;
		if (event.toolName === "read" && !event.isError) {
			const path = (event.input as { path?: unknown } | undefined)?.path;
			if (typeof path === "string" && path.length > 0) {
				const count = observeRead(state.readsThisRound, path);
				reread = buildRereadDetails(path, count);
			}
		}
		const details = withRereadDetails(event.details, reread);

		const tokens = estimateToolResultTokens(event.content);

		// A read of a quarantined payload re-enters the normal replacement
		// path: it is large by construction, so it gets a pending marker (if
		// above the pending threshold) but must NOT be re-quarantined — the
		// LLM explicitly asked for this content.
		if (event.toolName === "read_quarantined_result") {
			if (tokens <= config.toolResultThresholdTokens) {
				return;
			}
			recordPending(state, event.toolCallId, tokens, flattenContent(event.content));
			return {
				content: [...event.content, { type: "text" as const, text: buildPendingMarker(event.toolCallId, tokens) }],
			};
		}

		// Quarantine gate: above the (much higher) quarantine threshold the
		// content is withheld entirely — swapped for a notice, payload held for
		// one turn. No pending entry is recorded: there is nothing in context
		// to replace.
		if (
			config.quarantine &&
			tokens > config.quarantineThresholdTokens
		) {
			recordQuarantine(state, event.toolCallId, flattenContent(event.content), tokens, state.currentTurn);
			return {
				content: [
					{ type: "text" as const, text: buildQuarantineNotice(event.toolCallId, tokens) },
				],
				...(details ? { details } : {}),
			};
		}

		// Size gate: only results strictly above the configured token threshold
		// get a pending marker. Smaller results are too cheap to distill —
		// marking them wastes a toolCallId and steering budget. Empty results
		// are skipped here too (0 tokens is never above the threshold).
		if (tokens <= config.toolResultThresholdTokens) {
			// No marker — but a re-read still gets its details payload. A
			// details-only return is applied by the runner without touching
			// content.
			return details ? { details } : undefined;
		}

		const contentString = flattenContent(event.content);

		// Record in runtime state
		recordPending(state, event.toolCallId, tokens, contentString);

		// Append the pending marker to the LLM-facing content.
		// The original content stays intact; the marker is an extra text block.
		const marker = buildPendingMarker(event.toolCallId, tokens);
		return {
			content: [...event.content, { type: "text" as const, text: marker }],
			...(details ? { details } : {}),
		};
	});

	// -----------------------------------------------------------------------
	// 2. replace_tool_result tool registration
	//
	//    Accepts an array of {toolCallId, replacement} pairs so the LLM can
	//    replace many results in a single call — the natural shape for the
	//    "replace everything I've finished extracting" step. For robustness,
	//    the handler also accepts a single pair object (some models may emit
	//    one object instead of an array); both shapes are handled.
	// -----------------------------------------------------------------------
	interface ReplacePair {
		toolCallId: string;
		replacement: string;
	}

	interface PairResult {
		toolCallId: string;
		ok: boolean;
		reason?: string;
		originalTokens?: number;
		replacementTokens?: number;
		grew?: boolean;
	}

	function applyOne(pair: ReplacePair): PairResult {
		const entry = state.entries.get(pair.toolCallId);
		if (!entry) {
			return {
				toolCallId: pair.toolCallId,
				ok: false,
				reason: "unknown id",
			};
		}
		const replacementTokens = estimateTokens(pair.replacement);
		// No size gate: accept any replacement. Record a `grew` flag when the
		// replacement is at least as large as the original — the observation
		// target. If we see `grew: true` in real runs, that is the signal to
		// reintroduce a length gate.
		recordReplacement(state, pair.toolCallId, pair.replacement, replacementTokens);
		return {
			toolCallId: pair.toolCallId,
			ok: true,
			originalTokens: entry.originalTokens,
			replacementTokens,
			grew: replacementTokens >= entry.originalTokens,
		};
	}

	function summarizeResults(results: PairResult[]): string {
		const stored = results.filter((r) => r.ok);
		const lines: string[] = [];
		if (stored.length > 0) {
			lines.push(
				`Stored ${stored.length} replacement${stored.length === 1 ? "" : "s"}. ` +
					`Originals will be swapped in subsequent LLM calls:`,
			);
			for (const r of stored) {
				lines.push(
					`  - ${r.toolCallId}: ${r.replacementTokens} tokens ` +
						`(was ${r.originalTokens}${r.grew ? ", grew" : ""})`,
				);
			}
		}
		const failed = results.filter((r) => !r.ok);
		if (failed.length > 0) {
			lines.push(
				`Skipped ${failed.length} unknown id${failed.length === 1 ? "" : "s"}: ` +
					failed.map((r) => r.toolCallId).join(", "),
			);
		}
		return lines.join("\n");
	}

	api.registerTool({
		name: "replace_tool_result",
		label: "Replace Tool Result",
		description:
			"Replace tool results you have finished extracting with complete summaries. " +
			"Pass an `items` array of {toolCallId, replacement} pairs — one call can " +
			"replace many results at once. Method for each marked result: read it once, " +
			"extract ALL the information you may still need for the rest of the task into " +
			"the replacement, then replace. A replacement is irreversible — the original " +
			"is swapped out for good, and anything you failed to capture requires a fresh " +
			"full tool call to recover. So never replace while you still expect to consult " +
			"the full detail; and once extraction is complete, replace immediately — an " +
			"un-replaced result keeps costing context on every later call.",
		promptSnippet:
			"IMPORTANT: Call `replace_tool_result({ items: [{ toolCallId, replacement }, ...] })` " +
			"for every [tool-result-pending-replacement: ...] marker whose result you have read. " +
			"Batch many replacements into a single call. Method: extract ALL information you may " +
			"need later — numbers, paths, decisions, excerpts — into the replacement, then replace. " +
			"Replacement is irreversible: after it, the full original is gone, and recovering " +
			"anything you missed costs a fresh full tool call. Once extraction is complete, replace " +
			"immediately; do not defer, and do not replace half-informed.",
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					toolCallId: Type.String({
						description: "The toolCallId from the [tool-result-pending-replacement: ...] marker.",
					}),
					replacement: Type.String({
						description:
							"Tight but complete summary of the tool result: capture ALL the key " +
							"numbers, paths, decisions, or excerpts you may need later — not just " +
							"for the next step. After replacement the original is unretrievable " +
							"except by re-running the tool, so include anything you might consult.",
					}),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(
			toolCallId: string,
			params: { items: ReplacePair[] } | ReplacePair,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			// Accept both the documented array form and a bare single-pair object
			// for robustness against models that emit one object instead of an
			// array. Normalize to an array of pairs.
			let pairs: ReplacePair[];
			if (Array.isArray((params as { items?: ReplacePair[] }).items)) {
				pairs = (params as { items: ReplacePair[] }).items;
			} else if (
				typeof params === "object" &&
				params !== null &&
				typeof (params as ReplacePair).toolCallId === "string" &&
				typeof (params as ReplacePair).replacement === "string"
			) {
				pairs = [params as ReplacePair];
			} else {
				return {
					content: [
						{
							type: "text" as const,
							text: "Invalid arguments. Pass { items: [{ toolCallId, replacement }, ...] } " +
								"with at least one pair.",
						},
					],
					details: { ok: false, reason: "invalid arguments" },
				};
			}

			const results = pairs.map(applyOne);
			return {
				content: [
					{ type: "text" as const, text: summarizeResults(results) },
				],
				details: { ok: true, results },
			};
		},
	});

	// -----------------------------------------------------------------------
	// 2b. read_quarantined_result tool registration
	//
	//    Single-turn escape hatch for a quarantined payload. Honored only
	//    while the payload is held (the turn right after the quarantine); a
	//    read releases the payload — subsequent reads for the id are denied.
	//    The description deliberately stresses the cost (full payload back
	//    into context) and the preferred alternative (narrow the call).
	// -----------------------------------------------------------------------
	api.registerTool({
		name: "read_quarantined_result",
		label: "Read Quarantined Result",
		description:
			"Retrieve the full payload of a tool result that was quarantined as too large. " +
			"Know the trade-off before you call: the entire payload re-enters your context at full " +
			"token cost, and you can only do this in the response immediately after the " +
			"[tool-result-quarantined: ...] notice — the data is freed right after that response, " +
			"and later calls for the id are denied. If you need only part of the data, prefer " +
			"re-issuing a narrower version of the original tool call instead of reading. If you " +
			"need the whole payload, read it here once — do NOT reconstruct it piecemeal with " +
			"several narrowed calls; that costs more than one full read.",
		promptSnippet:
			"`read_quarantined_result({ toolCallId })` returns a tool result that was withheld " +
			"as too large. Call it only in your immediately next response, and only when the full " +
			"payload is truly needed — the quarantine is freed afterwards and the call is then " +
			"denied. When you do need it all, read it in one call rather than fetching the " +
			"content in pieces; prefer narrowing the original tool call only when part of the " +
			"data suffices.",
		parameters: Type.Object({
			toolCallId: Type.String({
				description:
					"The toolCallId shown in the [tool-result-quarantined: ...] notice.",
			}),
		}),
		async execute(
			toolCallId: string,
			params: { toolCallId: string },
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const entry = releaseQuarantine(state, params.toolCallId);
			if (!entry) {
				return {
					content: [
						{
							type: "text" as const,
							text: buildQuarantineMissedNotice(params.toolCallId),
						},
					],
					details: { ok: false, reason: "not held (already read, or window expired)" },
				};
			}
			return {
				content: [{ type: "text" as const, text: entry.payload }],
				details: { ok: true, toolCallId: params.toolCallId, tokens: entry.tokens },
			};
		},
	});

	// -----------------------------------------------------------------------
	// 3. before_agent_start — inject marker explanation and tool description
	//    into the system prompt
	// -----------------------------------------------------------------------
	api.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		// New round: reset the steering band so a pending pile persisting into
		// this round is re-announced on its first LLM call, and restart the
		// per-round re-read counter.
		resetSteering(steering);
		resetRereads(state.readsThisRound);

		// Defensive: a held payload never survives a round boundary. Live
		// quarantines are already evicted by the turn_end that closes their
		// one-turn window — this covers aborted runs that never reached it.
		clearQuarantines(state);
		const toolclipInstructions =
			"\n## Tool Result Replacement\n" +
			"When a long tool result has a [tool-result-pending-replacement: ...] marker, " +
			"you MUST replace it with `replace_tool_result({ items: [{ toolCallId, replacement }, ...] })` " +
			"before you make the next tool call or write your final answer. Batch many replacements " +
			"into a single call. Use one method, every time:\n" +
			"1. READ the result once, in full.\n" +
			"2. EXTRACT all the information you may still need for the rest of the task — numbers, " +
			"error codes, paths, decisions, excerpts, state — into the replacement. Not just what " +
			"the next step needs: anything you might consult later goes in now.\n" +
			"3. REPLACE. The swap is irreversible: the full original is dropped from your context " +
			"for good, and recovering anything you failed to capture means re-running the tool at " +
			"full cost.\n" +
			"Replacement is a completion step of extraction, not optional cleanup. But the " +
			"extraction must be complete BEFORE you replace. Replacing too early is the expensive " +
			"mistake: you lose the detail, discover the loss a turn later, and pay for a full " +
			"re-read. Deferring replacement after extraction is also expensive: the un-replaced " +
			"original keeps costing context on every later call.\n" +
			"Before you write your final answer, do the sweep. Replace, in a single " +
			"`replace_tool_result` call, every marked result you have already read but not yet " +
			"replaced. Having the answer ready is no reason to leave them: if nothing remains " +
			"marked-and-read, the sweep is a no-op — say so in one line and then answer.\n" +
			"- The larger the original, the more context you save, so large results are the " +
			"  priority. Do not let size become a reason to keep the full original around.\n" +
			"- Keep each replacement tight relative to the original — never re-quote whole files " +
			"  or listings — but complete relative to your future needs: a missing detail costs a " +
			"  full re-read, an included one costs a line.\n" +
			"- Drop verbose output such as file contents, full directory listings, or exhaustive " +
			"  search results as soon as you have extracted the relevant parts.\n" +
			"- Do NOT keep a result because you might quote it later. If you will reference a " +
			"  specific excerpt, put that excerpt into the replacement now and replace the " +
			"  whole result — do not park the full original for later quoting.\n" +
			"- The only valid reason to keep a marked result un-replaced is that you have not " +
			"  yet read it. Once you have read it, replace it before moving on.\n" +
			"\n## Quarantined Tool Results\n" +
			`A tool result above ${config.quarantineThresholdTokens} tokens is not shown to you at all: ` +
			"its content is replaced by a [tool-result-quarantined: ...] notice and the full payload is " +
			"held for exactly one response.\n" +
			"- First choice: never read it. Re-issue the tool call with a narrower scope (specific " +
			"  file, tighter pattern, smaller range) so the result comes back small enough to use.\n" +
			"- Only when the full payload is genuinely required, call " +
			"  `read_quarantined_result({ toolCallId: \"...\" })` in your immediately next response. That " +
			"  is the only window: once that response ends, the payload is freed and read attempts for " +
			"  it are denied.\n" +
			"- If you need the whole payload, read it from the quarantine — do NOT reconstruct it " +
			"  piecemeal (e.g. reading a large file in offset/limit chunks, or re-running the call " +
			"  several times with narrower scopes). Several partial fetches cost more calls and more " +
			"  tokens than one full read.\n" +
			"- Reading is costly: the whole payload returns to your context at full size. If you do " +
			"  read it, treat it like any other large result — extract what you need and replace it " +
			"  promptly via replace_tool_result.\n";

		return {
			systemPrompt: event.systemPrompt + toolclipInstructions,
		} satisfies BeforeAgentStartEventResult;
	});

	// -----------------------------------------------------------------------
	// 4. context event handler — swap replaced results before each LLM call,
	//    and append a trailing steering reminder when the pending count has
	//    entered a new multiple of `steeringReminderMultiple` (default 5).
	//
	//    The reminder is appended as a NEW trailing user message — pi's
	//    standard steering path. It touches only the tail; the cached prefix
	//    (original prompt + all prior messages) is never modified.
	// -----------------------------------------------------------------------
	api.on("context", (event: ContextEvent) => {
		const modified = event.messages.map((msg) => {
			if (msg.role !== "toolResult") {
				return msg;
			}
			const replacement = getReplacement(state, msg.toolCallId);
			if (replacement === undefined) {
				return msg;
			}
			// Swap content: replacement text + replaced marker
			return {
				...msg,
				content: [
					{ type: "text" as const, text: replacement },
					{ type: "text" as const, text: buildReplacedMarker(msg.toolCallId) },
				],
			};
		});

		// Steering reminder: count-based. Observe the pending count first —
		// it fires when the count first reaches each multiple of the band size
		// (5–9, 10–14, ...), and re-arms when the count drops back below the
		// announced band. The reminder lands LAST in the returned messages so
		// it is the freshest context the model sees — and the prefix up to it
		// stays cached.
		const pendingIds = unreplacedPendingIds(state);
		if (observePendingBand(steering, pendingIds.length, config.steeringReminderMultiple, config.steeringReminder)) {
			modified.push({
				role: "user" as const,
				content: [{ type: "text" as const, text: buildSteeringMessage(pendingIds.length, pendingIds) }],
				timestamp: Date.now(),
			});
		}

		return { messages: modified };
	});

	// -----------------------------------------------------------------------
	// 5. turn_start / turn_end — quarantine bookkeeping.
	//
	//    pi delivers a turn's tool results at that turn's turn_end, so the
	//    LLM first sees a quarantine notice when it generates the NEXT turn
	//    (`createdTurn + 1`). That next turn is the only read window; reads
	//    execute during it, before its turn_end. Eviction at turn_end with
	//    `createdTurn <= turnIndex - 1` therefore frees still-unread payloads
	//    exactly when their one-turn window closes, without ever evicting a
	//    payload that could not yet have been read.
	// -----------------------------------------------------------------------
	api.on("turn_start", (event: TurnStartEvent) => {
		state.currentTurn = event.turnIndex;
	});

	api.on("turn_end", (event: TurnEndEvent) => {
		evictExpiredQuarantines(state, event.turnIndex);
	});
}