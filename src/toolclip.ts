/**
 * toolclip — Targeted context reduction for individual tool results.
 *
 * Listens to the `tool_result` event; when a result exceeds the token
 * threshold, appends a pending-replacement marker to the LLM-facing content.
 * Registers `replace_tool_result(id, replacement)` so the LLM can swap the
 * bulky original for a tight replacement in subsequent turns. The length gate
 * (hard + soft fail) prevents replacements that don't meaningfully shrink
 * context.
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
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { loadToolclipConfig } from "../lib/toolclip-config.ts";
import { createRuntimeState } from "../lib/runtime-state.ts";
import { estimateTokens } from "../lib/tokens.ts";
import { buildPendingMarker, buildReplacedMarker } from "../lib/marker.ts";
import { validateReplacement } from "../lib/length-gate.ts";
import {
	recordPending,
	recordReplacement,
	getReplacement,
	clear,
} from "../lib/runtime-state.ts";
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

export default function toolclip(api: ExtensionAPI): void {
	const config = loadToolclipConfig();
	const state: ToolclipRuntimeState = createRuntimeState();

	// -----------------------------------------------------------------------
	// 1. tool_result event handler
	// -----------------------------------------------------------------------
	api.on("tool_result", (event: ToolResultEvent) => {
		// Only text tool results matter — we can't meaningfully ask the LLM
		// to summarise an empty result.
		const tokens = estimateToolResultTokens(event.content);
		if (tokens <= config.thresholdTokens) {
			return; // below threshold — no marker needed
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
	// -----------------------------------------------------------------------
	api.registerTool({
		name: "replace_tool_result",
		label: "Replace Tool Result",
		description:
			"Replace a long tool result with a tight summary. " +
			"The replacement must be strictly shorter than the original and " +
			"within the configured replacement ratio. " +
			"Call this for any tool result that has a " +
			"[tool-result-pending-replacement: ...] marker if you no longer " +
			"need the full original in later turns.",
		promptSnippet:
			"You may call `replace_tool_result(toolCallId, replacement)` to " +
			"swap a long tool result for a tight summary in subsequent turns. " +
			"The original stays until you do. Either option is fine.",
		parameters: Type.Object({
			toolCallId: Type.String({
				description: "The toolCallId from the [tool-result-pending-replacement: ...] marker.",
			}),
			replacement: Type.String({
				description:
					"Tight summary of the tool result. Must be strictly shorter " +
					"than the original and within the max-replacement-ratio.",
			}),
		}),
		async execute(
			toolCallId: string,
			params: { toolCallId: string; replacement: string },
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const entry = state.entries.get(params.toolCallId);
			if (!entry) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No pending tool result found for toolCallId "${params.toolCallId}". It may have already been replaced, or its result was below the threshold. Use get_tool_details or check the session history to find the correct id.`,
						},
					],
					details: { ok: false, reason: "unknown id" },
				};
			}

			const replacementTokens = estimateTokens(params.replacement);
			const gateResult = validateReplacement(
				entry.originalTokens,
				replacementTokens,
				config.maxReplacementRatio,
			);

			if (!gateResult.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Cannot replace: ${gateResult.reason}. ` +
								`Either make a tighter summary or skip replacement entirely.`,
						},
					],
					details: { ok: false, reason: gateResult.reason },
				};
			}

			recordReplacement(state, params.toolCallId, params.replacement);
			return {
				content: [
					{
						type: "text" as const,
						text: `Replacement stored for toolCallId "${params.toolCallId}". ` +
							`The original result will be swapped in subsequent LLM calls.`,
					},
				],
				details: {
					ok: true,
					originalTokens: entry.originalTokens,
					replacementTokens,
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// 3. before_agent_start — inject marker explanation and tool description
	//    into the system prompt
	// -----------------------------------------------------------------------
	api.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		const toolclipInstructions =
			"\n## Tool Result Replacement\n" +
			"When a long tool result has a [tool-result-pending-replacement: ...] marker, you may call `replace_tool_result(toolCallId, replacement)` to swap the bulky original for a tight summary in subsequent turns.\n" +
			"- Replace with only what you will need later: key numbers, error codes, paths, decisions, or state summaries.\n" +
			"- Drop verbose output like file contents, full directory listings, or exhaustive search results once you have extracted the relevant parts.\n" +
			"- If you don't call the tool, the original result stays untouched. Either option is fine.\n" +
			"- The replacement must be strictly shorter than the original and within the configured ratio.\n";

		return {
			systemPrompt: event.systemPrompt + toolclipInstructions,
		} satisfies BeforeAgentStartEventResult;
	});

	// -----------------------------------------------------------------------
	// 4. context event handler — swap replaced results before each LLM call
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

		return { messages: modified };
	});
}