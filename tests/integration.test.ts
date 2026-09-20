/**
 * Smoke integration test for the toolclip extension.
 *
 * Drives the full flow end-to-end against a mock pi event bus:
 *   1. A long tool result is emitted via the `tool_result` event.
 *   2. The next `context` event shows the pending marker in the LLM-facing
 *      message content.
 *   3. The LLM calls `replace_tool_result` to record a tight replacement.
 *   4. The next `context` event shows the swap (replacement + replaced marker).
 *
 * Also verifies the no-marker and cache-break paths.
 */

import { describe, expect, it } from "vitest";
import toolclip from "../src/toolclip.ts";
import { createMockApi, invokeHandler, invokeTool } from "./_helpers/mock-pi.ts";

const LONG_TEXT = "x".repeat(4004); // 4004/4 = ceil(1001) = 1001 tokens — above the 1000 threshold

describe("toolclip — smoke integration", () => {
	it("drives the full flow: marker → replace → swap on next context", async () => {
		const { handlers, tools, pi } = createMockApi();
		toolclip(pi as never);

		// 1. Long tool result arrives — extension records pending entry and
		//    appends marker to the LLM-facing content.
		const toolResult = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "bash-1",
			toolName: "bash",
			content: [{ type: "text", text: LONG_TEXT }],
			isError: false,
		}) as { content: Array<{ type: string; text: string }> };

		expect(toolResult.content).toHaveLength(2);
		expect(toolResult.content[1].text).toBe(
			"[tool-result-pending-replacement: toolCallId=bash-1, tokens=1001]",
		);

		// 2. Next `context` event includes the tool result message WITH the
		//    marker (the LLM must see the marker at least once).
		const firstContext = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "run the command" }] },
				{
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: toolResult.content, // marker already appended
					isError: false,
				},
			],
		}) as { messages: Array<Record<string, unknown>> };

		const firstMsg = firstContext.messages[1] as {
			content: Array<{ type: string; text: string }>;
		};
		expect(firstMsg.content).toHaveLength(2);
		expect(firstMsg.content[1].text).toContain("tool-result-pending-replacement");

		// 3. LLM decides to call replace_tool_result.
		const replaceResult = (await invokeTool(tools, "replace_tool_result", "llm-call-1", {
			items: [{ toolCallId: "bash-1", replacement: "ok, build passed" }],
		})) as { details: Record<string, unknown> };

		expect(replaceResult.details).toMatchObject({ ok: true });
		const rr = (replaceResult.details.results as Array<Record<string, unknown>>)[0];
		expect(rr.originalTokens).toBe(1001);
		expect(rr.replacementTokens).toBe(4);

		// 4. Next `context` event shows the swap (cache-break point).
		const secondContext = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "run the command" }] },
				{
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: toolResult.content, // original (with marker) — should be replaced
					isError: false,
				},
			],
		}) as { messages: Array<Record<string, unknown>> };

		const secondMsg = secondContext.messages[1] as {
			content: Array<{ type: string; text: string }>;
		};
		expect(secondMsg.content).toHaveLength(2);
		expect(secondMsg.content[0].text).toBe("ok, build passed");
		expect(secondMsg.content[1].text).toBe(
			"[tool-result-replaced: toolCallId=bash-1]",
		);

		// Original LLM-facing content was NEVER mutated — the marker is a
		// separate text block, the swap happens in the context event only.
		expect(toolResult.content[0].text).toBe(LONG_TEXT);
	});

	it("leaves messages untouched when no tool results are pending or replaced", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		// A tool result with no replacement recorded stays in place. This test
		// fires `context` directly without first emitting a tool_result event,
		// so no pending entry exists and the message is untouched. (A short
		// result would also be untouched at tool_result time, since it is below
		// the 1000-token threshold.)
		const event = {
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
				{
					role: "toolResult",
					toolCallId: "short-1",
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
				{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			],
		};

		const result = invokeHandler(handlers, "context", event) as {
			messages: Array<Record<string, unknown>>;
		};

		expect(result.messages).toEqual(event.messages);
	});

	it("preserves the swap across multiple context events (cache-break semantics)", async () => {
		const { handlers, tools, pi } = createMockApi();
		toolclip(pi as never);

		// Long tool result + replacement recorded.
		const toolResult = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "grep-1",
			toolName: "grep",
			content: [{ type: "text", text: LONG_TEXT }],
			isError: false,
		}) as { content: Array<{ type: string; text: string }> };

		await invokeTool(tools, "replace_tool_result", "llm-call-1", {
			items: [{ toolCallId: "grep-1", replacement: "match in line 42" }],
		});

		// Build a context event with the original (marker-included) content.
		// Both subsequent context events must see the swap, not the original.
		const event = {
			type: "context",
			messages: [
				{
					role: "toolResult",
					toolCallId: "grep-1",
					toolName: "grep",
					content: toolResult.content,
					isError: false,
				},
			],
		};

		const first = invokeHandler(handlers, "context", event) as {
			messages: Array<{ content: Array<{ text: string }> }>;
		};
		const second = invokeHandler(handlers, "context", event) as {
			messages: Array<{ content: Array<{ text: string }> }>;
		};

		expect(first.messages[0].content[0].text).toBe("match in line 42");
		expect(second.messages[0].content[0].text).toBe("match in line 42");
		expect(first.messages[0].content[1].text).toBe(
			"[tool-result-replaced: toolCallId=grep-1]",
		);
		expect(second.messages[0].content[1].text).toBe(
			"[tool-result-replaced: toolCallId=grep-1]",
		);
	});

	it("handles a mix of pending, replaced, and untouched tool results in one context", async () => {
		const { handlers, tools, pi } = createMockApi();
		toolclip(pi as never);

		// 1. Long result → pending.
		const pendingResult = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "pending-1",
			toolName: "bash",
			content: [{ type: "text", text: LONG_TEXT }],
			isError: false,
		}) as { content: Array<{ type: string; text: string }> };

		// 2. Long result → replaced.
		const replacedResult = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "replaced-1",
			toolName: "bash",
			content: [{ type: "text", text: LONG_TEXT }],
			isError: false,
		}) as { content: Array<{ type: string; text: string }> };

		await invokeTool(tools, "replace_tool_result", "llm-call-1", {
			items: [{ toolCallId: "replaced-1", replacement: "tight summary" }],
		});

		// 3. Short result → BELOW threshold, so no pending marker and no entry.
		//    It stays untouched in the context event (no swap).
		const shortResult = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "short-1",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
		}) as { content: Array<{ type: string; text: string }> };

		// Confirm the short result got no marker at tool_result time.
		expect(shortResult).toBeUndefined();

		// All three appear in the next context event.
		const event = {
			type: "context",
			messages: [
				{
					role: "toolResult",
					toolCallId: "pending-1",
					toolName: "bash",
					content: pendingResult.content,
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "replaced-1",
					toolName: "bash",
					content: replacedResult.content,
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "short-1",
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			],
		};

		const result = invokeHandler(handlers, "context", event) as {
			messages: Array<{ content: Array<{ text: string }> }>;
		};

		// Pending → unchanged (still has marker).
		expect(result.messages[0].content).toHaveLength(2);
		expect(result.messages[0].content[1].text).toContain("tool-result-pending-replacement");

		// Replaced → swapped.
		expect(result.messages[1].content[0].text).toBe("tight summary");
		expect(result.messages[1].content[1].text).toBe(
			"[tool-result-replaced: toolCallId=replaced-1]",
		);

		// Short → below threshold, never marked, so it stays as the single
		// original text block (no swap, no marker).
		expect(result.messages[2].content).toHaveLength(1);
		expect(result.messages[2].content[0].text).toBe("ok");
	});
});
