import { describe, expect, it } from "vitest";
import toolclip from "../src/toolclip.ts";
import { createMockApi, invokeHandler, invokeTool } from "./_helpers/mock-pi.ts";

// -----------------------------------------------------------------------
// tool_result event handler tests
// -----------------------------------------------------------------------
describe("tool_result handler", () => {
	it("appends a pending marker when result exceeds threshold (default 250 tokens)", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const longText = "x".repeat(1001); // 1001/4 = ceil(250.25) = 251 > 250
		const result = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: longText }],
			isError: false,
		});

		expect(result).toBeDefined();
		expect(result).toHaveProperty("content");
		const content = (result as { content: Array<{ type: string; text: string }> }).content;
		expect(content).toHaveLength(2); // original + marker
		expect(content[0].type).toBe("text");
		expect(content[0].text).toBe(longText);
		expect(content[1].type).toBe("text");
		expect(content[1].text).toMatch(
			/^\[tool-result-pending-replacement: toolCallId=read-1, tokens=251\]$/,
		);
	});

	it("does NOT append a marker when result is below threshold", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const shortText = "x".repeat(500); // 500/4 = 125 ≤ 250
		const result = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "read-2",
			toolName: "read",
			content: [{ type: "text", text: shortText }],
			isError: false,
		});

		expect(result).toBeUndefined();
	});

	it("does NOT append a marker for an empty result (0 tokens)", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const result = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "empty-1",
			toolName: "read",
			content: [{ type: "text", text: "" }],
			isError: false,
		});

		expect(result).toBeUndefined();
	});

	it("counts tokens across multiple text blocks", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const block1 = "x".repeat(600);  // 150 tokens
		const block2 = "y".repeat(604);  // 151 tokens
		// Total: 301 tokens > 250
		const result = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "multi-1",
			toolName: "grep",
			content: [
				{ type: "text", text: block1 },
				{ type: "text", text: block2 },
			],
			isError: false,
		});

		expect(result).toBeDefined();
		const content = (result as { content: Array<{ type: string; text: string }> }).content;
		expect(content).toHaveLength(3);
		expect(content[2].text).toContain("tokens=301");
	});

	it("ignores image blocks in token count (short text stays below threshold)", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const result = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "img-1",
			toolName: "read",
			content: [
				{ type: "text", text: "short description" },
				{ type: "image", mimeType: "image/png", data: "abc123" },
			],
			isError: false,
		});

		// 16 chars / 4 = 4 tokens → below 250
		expect(result).toBeUndefined();
	});

	it("does not mutate the original event content array", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const originalContent = [{ type: "text" as const, text: "x".repeat(2500) }];
		const event = {
			type: "tool_result",
			toolCallId: "mutate-1",
			toolName: "read",
			content: originalContent,
			isError: false,
		};

		invokeHandler(handlers, "tool_result", event);

		expect(originalContent).toHaveLength(1);
		expect(originalContent[0].text).toBe("x".repeat(2500));
	});
});

// -----------------------------------------------------------------------
// replace_tool_result tool tests
// -----------------------------------------------------------------------
describe("replace_tool_result tool", () => {
	it("accepts a valid replacement that passes both gates", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		// Emit a long tool result to create a pending entry
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-1",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(2000) }],
			isError: false,
		});

		const result = (await invokeTool(tools, "replace_tool_result", "tool-1", {
			toolCallId: "tool-1",
			replacement: "short summary",
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

		expect(result.details).toMatchObject({ ok: true });
		expect(result.details.originalTokens).toBe(500);
		expect(result.details.replacementTokens).toBe(4);
	});

	it("rejects replacement that is longer than original (hard fail)", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		// 1200 chars / 4 = 300 tokens > 250 threshold, so entry is recorded
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-hard",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(1200) }],
			isError: false,
		});

		// 1300 chars / 4 = 325 tokens > 300 original
		const result = (await invokeTool(tools, "replace_tool_result", "tool-hard", {
			toolCallId: "tool-hard",
			replacement: "x".repeat(1300),
		})) as { details: Record<string, unknown> };

		expect(result.details).toMatchObject({ ok: false });
		expect(result.details.reason).toContain("must be strictly shorter");
	});

	it("rejects replacement that exceeds the soft-fail ratio (soft fail)", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-soft",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(4000) }],
			isError: false,
		});

		const result = (await invokeTool(tools, "replace_tool_result", "tool-soft", {
			toolCallId: "tool-soft",
			replacement: "y".repeat(500),
		})) as { details: Record<string, unknown> };

		expect(result.details).toMatchObject({ ok: false });
		expect(result.details.reason).toContain("exceeds the maximum allowed fraction");
	});

	it("returns error for unknown toolCallId", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		const result = (await invokeTool(tools, "replace_tool_result", "nonexistent", {
			toolCallId: "nonexistent",
			replacement: "whatever",
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

		expect(result.details).toMatchObject({ ok: false, reason: "unknown id" });
		expect(result.content[0].text).toContain('"nonexistent"');
	});

	it("is idempotent: calling again with same id updates the replacement", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-idem",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(2000) }],
			isError: false,
		});

		const res1 = (await invokeTool(tools, "replace_tool_result", "tool-idem", {
			toolCallId: "tool-idem",
			replacement: "ver1",
		})) as { details: Record<string, unknown> };
		expect(res1.details.ok).toBe(true);

		const res2 = (await invokeTool(tools, "replace_tool_result", "tool-idem", {
			toolCallId: "tool-idem",
			replacement: "v2",
		})) as { details: Record<string, unknown> };
		expect(res2.details.ok).toBe(true);
		expect(res2.details.replacementTokens).toBe(1);
	});

	it("handles zero-length replacement (0 tokens — trivially passes)", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-zero",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(2000) }],
			isError: false,
		});

		const result = (await invokeTool(tools, "replace_tool_result", "tool-zero", {
			toolCallId: "tool-zero",
			replacement: "",
		})) as { details: Record<string, unknown> };

		expect(result.details).toMatchObject({ ok: true });
	});
});

// -----------------------------------------------------------------------
// context event handler tests
// -----------------------------------------------------------------------
describe("context event handler", () => {
	it("swaps replaced content and leaves non-matching messages untouched", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		// Emit a long tool result and replace it
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "replaced-1",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(2000) }],
			isError: false,
		});

		await invokeTool(tools, "replace_tool_result", "replaced-1", {
			toolCallId: "replaced-1",
			replacement: "shortened",
		});

		// Now fire the context event with a mixed set of messages
		const event = {
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
				{
					role: "toolResult",
					toolCallId: "replaced-1",
					toolName: "bash",
					content: [{ type: "text", text: "original content here" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "not-replaced",
					toolName: "read",
					content: [{ type: "text", text: "untouched" }],
					isError: false,
				},
			],
		};

		const result = invokeHandler(handlers, "context", event) as {
			messages: Array<Record<string, unknown>>;
		};

		expect(result.messages).toHaveLength(3);

		// User message untouched
		const userMsg = result.messages[0];
		expect(userMsg.role).toBe("user");
		expect((userMsg.content as Array<{ text: string }>)[0].text).toBe("hello");

		// Replaced tool result gets the swap
		const replacedMsg = result.messages[1];
		expect(replacedMsg.role).toBe("toolResult");
		const replacedContent = replacedMsg.content as Array<{ type: string; text: string }>;
		expect(replacedContent).toHaveLength(2);
		expect(replacedContent[0].text).toBe("shortened");
		expect(replacedContent[1].text).toBe("[tool-result-replaced: toolCallId=replaced-1]");

		// Untouched tool result stays as-is
		const untouchedMsg = result.messages[2];
		expect(untouchedMsg.role).toBe("toolResult");
		expect((untouchedMsg.content as Array<{ text: string }>)[0].text).toBe("untouched");
	});

	it("does not change messages when no tool results are replaced", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const event = {
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
				{
					role: "toolResult",
					toolCallId: "some-id",
					toolName: "read",
					content: [{ type: "text", text: "some result" }],
					isError: false,
				},
			],
		};

		const result = invokeHandler(handlers, "context", event) as {
			messages: Array<Record<string, unknown>>;
		};

		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]).toMatchObject({ role: "user" });
		expect(result.messages[1]).toMatchObject({ role: "toolResult" });
	});

	it("handles context with no tool results at all", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const event = {
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
				{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			],
		};

		const result = invokeHandler(handlers, "context", event) as {
			messages: Array<Record<string, unknown>>;
		};

		expect(result.messages).toEqual(event.messages);
	});
});

// -----------------------------------------------------------------------
// before_agent_start event handler tests
// -----------------------------------------------------------------------
describe("before_agent_start handler", () => {
	it("appends toolclip instructions to the system prompt", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const event = {
			type: "before_agent_start",
			prompt: "list files",
			images: undefined,
			systemPrompt: "You are a helpful assistant.",
			systemPromptOptions: { cwd: "/home/test" },
		};

		const result = invokeHandler(handlers, "before_agent_start", event) as {
			systemPrompt: string;
		};

		// Original prompt is preserved verbatim.
		expect(result.systemPrompt.startsWith("You are a helpful assistant.")).toBe(true);
		// Key directives of the sharpened prompt are present.
		expect(result.systemPrompt).toContain("## Tool Result Replacement");
		expect(result.systemPrompt).toContain(
			"you MUST call `replace_tool_result(toolCallId, replacement)` once you have",
		);
		expect(result.systemPrompt).toContain(
			"Replacement is a completion step of extraction, not optional cleanup",
		);
		expect(result.systemPrompt).toContain(
			"Do not let size become a reason to keep the full original around",
		);
		expect(result.systemPrompt).toContain(
			"The replacement must be strictly shorter than the original",
		);
		expect(result.systemPrompt).toContain("replace it before moving on");
	});

	it("appends to an empty system prompt", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const event = {
			type: "before_agent_start",
			prompt: "list files",
			images: undefined,
			systemPrompt: "",
			systemPromptOptions: { cwd: "/home/test" },
		};

		const result = invokeHandler(handlers, "before_agent_start", event) as {
			systemPrompt: string;
		};

		expect(result.systemPrompt).toContain("## Tool Result Replacement");
		expect(result.systemPrompt).toContain("replace_tool_result");
		expect(result.systemPrompt).toContain(
			"you MUST call `replace_tool_result(toolCallId, replacement)` once you have",
		);
	});

	it("keeps the original prompt when no handler is registered", () => {
		const { handlers } = createMockApi();
		// Don't call toolclip — no handlers registered

		const event = {
			type: "before_agent_start",
			prompt: "list files",
			images: undefined,
			systemPrompt: "You are a helpful assistant.",
			systemPromptOptions: { cwd: "/home/test" },
		};

		const result = invokeHandler(handlers, "before_agent_start", event);
		expect(result).toBeUndefined();
	});
});