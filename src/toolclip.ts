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
 * that would be a loop.
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
	MessageEndEvent,
	TurnStartEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { loadToolclipConfig } from "../lib/toolclip-config.ts";
import { createRuntimeState } from "../lib/runtime-state.ts";
import {
	estimateTokens,
	estimateMessagesTokens,
	countMessagesChars,
	createCalibrator,
	setSnapshotChars,
	setOverheadChars,
	observeTokens,
	getDivisor,
} from "../lib/tokens.ts";
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
	unreplacedPendingCount,
	observeTurn,
	shouldFireSteering,
	markFired,
	buildSteeringMessage,
} from "../lib/steering.ts";
import {
	recordPending,
	recordReplacement,
	getReplacement,
} from "../lib/runtime-state.ts";
import type { ToolclipRuntimeState } from "../lib/types.ts";

/**
 * Estimate the total text length of a tool result's content array.
 *
 * Content is `(TextContent | ImageContent)[]`. Only text blocks contribute
 * to the token estimate. Image blocks contribute their description text
 * (if any) plus a fixed overhead representing the base64 data.
 */
function estimateToolResultTokens(
	content: ToolResultEvent["content"],
	divisor: number,
): number {
	let total = 0;
	for (const block of content) {
		if (block.type === "text") {
			total += estimateTokens(block.text, divisor);
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

export default function toolclip(api: ExtensionAPI): void {
	const config = loadToolclipConfig();
	const state: ToolclipRuntimeState = createRuntimeState();
	const steering = createSteeringState();
	const calibrator = createCalibrator(config.calibratorInitialDivisor);

	// Read the current calibrated divisor. When calibration is disabled the
	// divisor is fixed at the configured initial value.
	function divisor(): number {
		return config.calibrate ? getDivisor(calibrator) : config.calibratorInitialDivisor;
	}

	// -----------------------------------------------------------------------
	// 1. tool_result event handler
	//
	//    Three outcomes, in order:
	//    a. replace_tool_result results — skipped (self-replacement loop).
	//    b. read_quarantined_result results — never re-quarantined (that
	//       would be a loop); they fall through the normal pending-marker
	//       path so the freshly-returned payload is replaceable.
	//    c. everything else — quarantined above the quarantine threshold
	//       (payload withheld), pending-marked above the pending threshold,
	//       untouched below it.
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

		const tokens = estimateToolResultTokens(event.content, divisor());

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
			};
		}

		// Size gate: only results strictly above the configured token threshold
		// get a pending marker. Smaller results are too cheap to distill —
		// marking them wastes a toolCallId and steering budget. Empty results
		// are skipped here too (0 tokens is never above the threshold).
		if (tokens <= config.toolResultThresholdTokens) {
			return;
		}

		const contentString = flattenContent(event.content);

		// Record in runtime state
		recordPending(state, event.toolCallId, tokens, contentString);

		// Append the pending marker to the LLM-facing content.
		// The original content stays intact; the marker is an extra text block.
		const marker = buildPendingMarker(event.toolCallId, tokens);
		return {
			content: [...event.content, { type: "text" as const, text: marker }],
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
		const replacementTokens = estimateTokens(pair.replacement, divisor());
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
			"Replace tool results you have already read with tight summaries. " +
			"Pass an `items` array of {toolCallId, replacement} pairs — one call can " +
			"replace many results at once. You SHOULD call this for every " +
			"[tool-result-pending-replacement: ...] marker as soon as you have " +
			"extracted the relevant information. Do not defer replacement — the " +
			"earlier you replace, the more context you save.",
		promptSnippet:
			"IMPORTANT: Call `replace_tool_result({ items: [{ toolCallId, replacement }, ...] })` " +
			"for every [tool-result-pending-replacement: ...] marker you see. Batch many " +
			"replacements into a single call. Extract the key information from each tool " +
			"result, then replace it. Large tool results consume context tokens that could " +
			"be used for reasoning. Replace them as soon as you can derive the relevant " +
			"information from a single result.",
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					toolCallId: Type.String({
						description: "The toolCallId from the [tool-result-pending-replacement: ...] marker.",
					}),
					replacement: Type.String({
						description:
							"Tight summary of the tool result: the key numbers, paths, " +
							"decisions, or excerpts you will need later — enough to answer " +
							"future questions that depend on this result.",
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
			"and later calls for the id are denied. Prefer re-issuing a narrower version of the " +
			"original tool call instead of reading.",
		promptSnippet:
			"`read_quarantined_result({ toolCallId })` returns a tool result that was withheld " +
			"as too large. Call it only in your immediately next response, and only when the full " +
			"payload is truly needed — the quarantine is freed afterwards and the call is then " +
			"denied. Prefer narrowing the original tool call instead.",
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
		// New round: reset the steering latch so the reminder can fire at most
		// once for this round.
		resetSteering(steering);

		// Defensive: a held payload never survives a round boundary. Live
		// quarantines are already evicted by the turn_end that closes their
		// one-turn window — this covers aborted runs that never reached it.
		clearQuarantines(state);
		const toolclipInstructions =
			"\n## Tool Result Replacement\n" +
			"When a long tool result has a [tool-result-pending-replacement: ...] marker, " +
			"you MUST call `replace_tool_result({ items: [{ toolCallId, replacement }, ...] })` " +
			"once you have extracted what you need from that result — before you make the next " +
			"tool call or write your final answer. Batch many replacements into a single call.\n" +
			"Before you write your final answer, do the sweep. Replace, in a single " +
			"`replace_tool_result` call, every marked result you have already read but not yet " +
			"replaced. Having the answer ready is no reason to leave them: if nothing remains " +
			"marked-and-read, the sweep is a no-op — say so in one line and then answer.\n" +
			"- Replacement is a completion step of extraction, not optional cleanup. The trigger " +
			"  is simple: once you have captured the relevant information from a marked result " +
			"  into your reasoning or into your replacement, that result is spent — replace it now.\n" +
			"- The larger the original, the more context you save, so large results are the " +
			"  priority. Do not let size become a reason to keep the full original around.\n" +
			"- Capture what you need: key numbers, error codes, paths, decisions, or state " +
			"  summaries — enough to answer future questions that depend on this result. Then " +
			"  replace the full output with that distilled summary.\n" +
			"- Drop verbose output such as file contents, full directory listings, or exhaustive " +
			"  search results as soon as you have extracted the relevant parts.\n" +
			"- Do NOT keep a result because you might quote it later. If you will reference a " +
			"  specific excerpt, put that excerpt into the replacement now and replace the " +
			"  whole result — do not park the full original for later quoting.\n" +
			"- Keep each replacement tight: the point is to free context, so capture only " +
			"  what you will actually need later.\n" +
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
			"- Reading is costly: the whole payload returns to your context at full size. If you do " +
			"  read it, treat it like any other large result — extract what you need and replace it " +
			"  promptly via replace_tool_result.\n";

		// Calibration scope: the denominator (total prompt tokens) covers the
		// system prompt and the serialized tool definitions, which are absent
		// from the messages array the `context` handler snapshots. Record their
		// character counts as the calibrator's overhead so both sides of the
		// ratio cover the same scope. event.systemPrompt is the fully assembled
		// prompt for this round BEFORE our appended instructions.
		let toolDefChars = 0;
		if (typeof api.getAllTools === "function" && typeof api.getActiveTools === "function") {
			const active = new Set(api.getActiveTools());
			for (const tool of api.getAllTools()) {
				if (!active.has(tool.name)) {
					continue;
				}
				toolDefChars += JSON.stringify({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				}).length;
			}
		}
		setOverheadChars(
			calibrator,
			(typeof event.systemPrompt === "string" ? event.systemPrompt.length : 0) +
				toolclipInstructions.length +
				toolDefChars,
		);

		return {
			systemPrompt: event.systemPrompt + toolclipInstructions,
		} satisfies BeforeAgentStartEventResult;
	});

	// -----------------------------------------------------------------------
	// 4. context event handler — swap replaced results before each LLM call,
	//    and (once per round) append a trailing steering reminder when the
	//    agent has left marked results un-replaced for several turns.
	//
	//    The reminder is appended as a NEW trailing user message — pi's
	//    standard steering path. It touches only the tail; the cached prefix
	//    (original prompt + all prior messages) is never modified.
	// -----------------------------------------------------------------------
	api.on("context", (event: ContextEvent) => {
		// Calibration: snapshot the character count of the (unmodified)
		// message array. This corresponds to the prompt that the immediately
		// following LLM call will see; `message_end` pairs it with the model's
		// actual `usage.input` for that call. We count the ORIGINAL messages,
		// not the `modified` array, so the snapshot is the true pre-swap input
		// pi sends. (The swap and steering append happen after this snapshot.)
		if (config.calibrate) {
			setSnapshotChars(calibrator, countMessagesChars(event.messages));
		}

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

		// Steering reminder: at most once per round. Observe this turn first
		// (advances the pending-turn counter when there is something to remind
		// about), then decide. The reminder lands LAST in the returned messages
		// so it is the freshest context the model sees — and the prefix up to it
		// stays cached.
		const unreplaced = unreplacedPendingCount(state);
		observeTurn(steering, unreplaced);
		if (shouldFireSteering(steering, unreplaced, config.steeringReminderTurn, config.steeringReminder)) {
			markFired(steering);
			modified.push({
				role: "user" as const,
				content: [{ type: "text" as const, text: buildSteeringMessage(unreplaced) }],
				timestamp: Date.now(),
			});
		}

		return { messages: modified };
	});

	// -----------------------------------------------------------------------
	// 5. message_end event handler — calibrate the token-estimator divisor.
	//
	//    Each assistant message carries the model's usage for the prompt that
	//    produced it. We already snapped that prompt's character count in the
	//    preceding `context` handler, so here we blend the observed
	//    chars-per-token ratio into the running divisor (EMA).
	//
	//    Scope fix: providers report `usage.input` as ONLY the non-cached
	//    portion of the prompt (pi-ai normalizes OpenAI-completions usage as
	//    `input = prompt_tokens − cached − cache_write`); cached tokens ride
	//    in `usage.cacheRead` / `usage.cacheWrite`. Pairing snapshotChars
	//    (the whole history) with `input` alone made the observed ratio
	//    explode as the cache grew — the divisor ratcheted from 4 to ~35 in
	//    the golden-sample session. The denominator is therefore the TOTAL
	//    prompt tokens: input + cacheRead + cacheWrite.
	//
	//    Only assistant messages have `usage`; user/toolResult messages are
	//    ignored. Degenerate samples (zero/non-finite chars or tokens) are
	//    skipped by `observeTokens`; the blended result is clamped to [2, 8].
	// -----------------------------------------------------------------------
	api.on("message_end", (event: MessageEndEvent) => {
		const usage = (
			event.message as { usage?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown } }
		).usage;
		if (!usage || typeof usage.input !== "number" || config.calibrate === false) {
			return;
		}
		const input = usage.input;
		const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
		const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
		const snapshotChars = calibrator.latestChars;
		if (snapshotChars === null) {
			return;
		}
		observeTokens(calibrator, snapshotChars, input + cacheRead + cacheWrite);
	});

	// -----------------------------------------------------------------------
	// 6. turn_start / turn_end — quarantine bookkeeping.
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