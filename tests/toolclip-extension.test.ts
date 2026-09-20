import { describe, expect, it } from "vitest";
import toolclip from "../src/toolclip.ts";
import { createMockApi, invokeHandler, invokeTool } from "./_helpers/mock-pi.ts";
import type { Handler } from "./_helpers/mock-pi.ts";

// -----------------------------------------------------------------------
// tool_result event handler tests
// -----------------------------------------------------------------------
describe("tool_result handler", () => {
	it("appends a pending marker to a result above the token threshold", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		// 4004 chars / 4 = ceil(1001) = 1001 tokens — just above the 1000 default.
		const longText = "x".repeat(4004);
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
			/^\[tool-result-pending-replacement: toolCallId=read-1, tokens=1001\]$/,
		);
	});

	it("does NOT append a marker to a result at or below the token threshold", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		// 500 chars / 4 = 125 tokens — well below the 1000 default. Small
		// results are too cheap to distill; marking them wastes budget.
		const shortText = "x".repeat(500);
		const result = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "read-2",
			toolName: "read",
			content: [{ type: "text", text: shortText }],
			isError: false,
		});

		expect(result).toBeUndefined();
	});

	it("appends a marker to a short result when the threshold is lowered via env", () => {
		const { handlers, pi } = createMockApi();
		const prev = process.env.TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS;
		process.env.TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS = "100";
		try {
			toolclip(pi as never);

			// 500/4 = 125 tokens > 100 threshold → marked.
			const shortText = "x".repeat(500);
			const result = invokeHandler(handlers, "tool_result", {
				type: "tool_result",
				toolCallId: "read-low",
				toolName: "read",
				content: [{ type: "text", text: shortText }],
				isError: false,
			});

			expect(result).toBeDefined();
			const content = (result as { content: Array<{ type: string; text: string }> }).content;
			expect(content).toHaveLength(2);
			expect(content[1].text).toContain("tokens=125");
		} finally {
			if (prev === undefined) {
				delete process.env.TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS;
			} else {
				process.env.TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS = prev;
			}
		}
	});

	it("does NOT append a marker for an empty result (0 tokens, below threshold)", () => {
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

		const block1 = "x".repeat(2000);  // 500 tokens
		const block2 = "y".repeat(2004);  // 501 tokens
		// Total: 1001 tokens — above the 1000 default.
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
		expect(content[2].text).toContain("tokens=1001");
	});

	it("does not append a marker when the only text is short but present (image blocks ignored)", () => {
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

		// 17 chars / 4 = ceil(4.25) = 5 tokens — non-zero but below the 1000
		// threshold, so no marker. Image blocks never contribute to the estimate.
		expect(result).toBeUndefined();
	});

	it("does not append a marker when content has only an image and no text", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const result = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "img-only",
			toolName: "read",
			content: [{ type: "image", mimeType: "image/png", data: "abc123" }],
			isError: false,
		});

		// 0 text tokens → nothing to distill → no marker.
		expect(result).toBeUndefined();
	});

	it("does not mutate the original event content array", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const originalContent = [{ type: "text" as const, text: "x".repeat(4004) }];
		const event = {
			type: "tool_result",
			toolCallId: "mutate-1",
			toolName: "read",
			content: originalContent,
			isError: false,
		};

		invokeHandler(handlers, "tool_result", event);

		expect(originalContent).toHaveLength(1);
		expect(originalContent[0].text).toBe("x".repeat(4004));
	});

	it("does NOT append a marker to the result of replace_tool_result itself (self-replacement guard)", () => {
		// Regression: without the toolName guard, every replace_tool_result
		// call's own result ("Stored N replacements…") would get a pending
		// marker, inducing a loop where the LLM re-replaces its own
		// replacement results. The handler must early-return for its own tool.
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const result = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "replace-call-1",
			toolName: "replace_tool_result",
			content: [{ type: "text", text: "Stored 1 replacement. Originals will be swapped in subsequent LLM calls: - foo: 4 tokens (was 500)" }],
			isError: false,
		});

		// No marker appended — the handler returned undefined.
		expect(result).toBeUndefined();
	});
});

// -----------------------------------------------------------------------
// replace_tool_result tool tests
// -----------------------------------------------------------------------
describe("replace_tool_result tool", () => {
	it("accepts a single-pair array and records the replacement (grew=false)", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		// Emit a tool result to create a pending entry (4004 chars = 1001 tokens, above threshold)
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-1",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(4004) }],
			isError: false,
		});

		const result = (await invokeTool(tools, "replace_tool_result", "tool-1", {
			items: [{ toolCallId: "tool-1", replacement: "short summary" }],
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

		expect(result.details).toMatchObject({ ok: true });
		const r0 = (result.details.results as Array<Record<string, unknown>>)[0];
		expect(r0).toMatchObject({ toolCallId: "tool-1", ok: true });
		expect(r0.originalTokens).toBe(1001);
		expect(r0.replacementTokens).toBe(4);
		expect(r0.grew).toBe(false);
	});

	it("accepts a bare single-pair object (robustness) and records it", async () => {
		// Some models may emit a single object instead of an {items} array.
		// The handler normalizes both shapes.
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-bare",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(4004) }],
			isError: false,
		});

		const result = (await invokeTool(tools, "replace_tool_result", "tool-bare", {
			toolCallId: "tool-bare",
			replacement: "bare summary",
		})) as { details: Record<string, unknown> };

		expect(result.details).toMatchObject({ ok: true });
		const r0 = (result.details.results as Array<Record<string, unknown>>)[0];
		expect(r0).toMatchObject({ toolCallId: "tool-bare", ok: true, grew: false });
	});

	it("accepts a replacement larger than the original (no gate) and flags grew=true", async () => {
		// Size thresholds removed: a replacement larger than the original is
		// accepted. The `grew` flag is the observation target — if we see it
		// true in real runs, that is the signal to reintroduce a gate.
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		// 5200 chars / 4 = 1300 tokens (above threshold)
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-grew",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(5200) }],
			isError: false,
		});

		// 5600 chars / 4 = 1400 tokens > 1300 original — previously hard-failed.
		const result = (await invokeTool(tools, "replace_tool_result", "tool-grew", {
			items: [{ toolCallId: "tool-grew", replacement: "x".repeat(5600) }],
		})) as { details: Record<string, unknown> };

		const r0 = (result.details.results as Array<Record<string, unknown>>)[0];
		expect(r0).toMatchObject({ ok: true });
		expect(r0.originalTokens).toBe(1300);
		expect(r0.replacementTokens).toBe(1400);
		expect(r0.grew).toBe(true);
	});

	it("accepts a replacement that previously would have soft-failed the ratio", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-soft",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(8000) }],
			isError: false,
		});

		// 500 chars / 4 = 125 tokens vs 2000 original → ratio 0.0625, previously
		// rejected by the 0.1 soft-fail ceiling. Now accepted.
		const result = (await invokeTool(tools, "replace_tool_result", "tool-soft", {
			items: [{ toolCallId: "tool-soft", replacement: "y".repeat(500) }],
		})) as { details: Record<string, unknown> };

		const r0 = (result.details.results as Array<Record<string, unknown>>)[0];
		expect(r0).toMatchObject({ ok: true, grew: false });
	});

	it("returns error for unknown toolCallId in a batch", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		const result = (await invokeTool(tools, "replace_tool_result", "call-1", {
			items: [{ toolCallId: "nonexistent", replacement: "whatever" }],
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

		expect(result.details).toMatchObject({ ok: true }); // the call itself succeeded
		const r0 = (result.details.results as Array<Record<string, unknown>>)[0];
		expect(r0).toMatchObject({ toolCallId: "nonexistent", ok: false, reason: "unknown id" });
		expect(result.content[0].text).toContain("nonexistent");
	});

	it("is idempotent: calling again with same id updates the replacement", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-idem",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(4004) }],
			isError: false,
		});

		const res1 = (await invokeTool(tools, "replace_tool_result", "tool-idem", {
			items: [{ toolCallId: "tool-idem", replacement: "ver1" }],
		})) as { details: Record<string, unknown> };
		const r1 = (res1.details.results as Array<Record<string, unknown>>)[0];
		expect(r1.ok).toBe(true);

		const res2 = (await invokeTool(tools, "replace_tool_result", "tool-idem", {
			items: [{ toolCallId: "tool-idem", replacement: "v2" }],
		})) as { details: Record<string, unknown> };
		const r2 = (res2.details.results as Array<Record<string, unknown>>)[0];
		expect(r2.ok).toBe(true);
		expect(r2.replacementTokens).toBe(1);
	});

	it("handles zero-length replacement (0 tokens)", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-zero",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(4004) }],
			isError: false,
		});

		const result = (await invokeTool(tools, "replace_tool_result", "tool-zero", {
			items: [{ toolCallId: "tool-zero", replacement: "" }],
		})) as { details: Record<string, unknown> };

		const r0 = (result.details.results as Array<Record<string, unknown>>)[0];
		expect(r0).toMatchObject({ ok: true, grew: false });
	});

	it("replaces multiple results in a single batch call", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		// Two pending entries + one unknown id in the same batch.
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "batch-a",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(4004) }],
			isError: false,
		});
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "batch-b",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(8000) }],
			isError: false,
		});

		const result = (await invokeTool(tools, "replace_tool_result", "call-1", {
			items: [
				{ toolCallId: "batch-a", replacement: "summary a" },
				{ toolCallId: "batch-b", replacement: "summary b" },
				{ toolCallId: "no-such-id", replacement: "ghost" },
			],
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

		expect(result.details).toMatchObject({ ok: true });
		const results = result.details.results as Array<Record<string, unknown>>;
		expect(results).toHaveLength(3);
		expect(results[0]).toMatchObject({ toolCallId: "batch-a", ok: true, grew: false });
		expect(results[1]).toMatchObject({ toolCallId: "batch-b", ok: true, grew: false });
		expect(results[2]).toMatchObject({ toolCallId: "no-such-id", ok: false, reason: "unknown id" });
		// Summary text lists both stored and the skipped unknown.
		expect(result.content[0].text).toContain("Stored 2 replacements");
		expect(result.content[0].text).toContain("batch-a");
		expect(result.content[0].text).toContain("batch-b");
		expect(result.content[0].text).toContain("Skipped 1 unknown id");
		expect(result.content[0].text).toContain("no-such-id");
	});

	it("rejects invalid arguments (neither items array nor single pair)", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		const result = (await invokeTool(tools, "replace_tool_result", "call-1", {
			items: "not-an-array",
		})) as { details: Record<string, unknown> };

		expect(result.details).toMatchObject({ ok: false, reason: "invalid arguments" });
	});
});

// -----------------------------------------------------------------------
// context event handler tests
// -----------------------------------------------------------------------
describe("context event handler", () => {
	it("swaps replaced content and leaves non-matching messages untouched", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		// Emit a long tool result and replace it (4004 chars = 1001 tokens, above threshold)
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "replaced-1",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(4004) }],
			isError: false,
		});

		await invokeTool(tools, "replace_tool_result", "replaced-1", {
			items: [{ toolCallId: "replaced-1", replacement: "shortened" }],
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
// steering reminder tests (context handler)
// -----------------------------------------------------------------------
describe("steering reminder injection", () => {
	const LONG = "x".repeat(4004); // 1001 tokens — above the 1000 threshold

	// Helper: emit a tool_result to create a pending (un-replaced) entry.
	function emitPending(handlers: Map<string, Handler[]>, toolCallId: string): void {
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: LONG }],
			isError: false,
		});
	}

	function fireContext(
		handlers: Map<string, Handler[]>,
		toolCallId: string,
	): { messages: Array<Record<string, unknown>> } {
		return invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{
					role: "toolResult",
					toolCallId,
					toolName: "bash",
					content: [{ type: "text", text: LONG }],
					isError: false,
				},
			],
		}) as { messages: Array<Record<string, unknown>> };
	}

	it("does not inject a reminder when there are no pending markers", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		// Fire several context events with no pending entries at all.
		for (let i = 0; i < 5; i++) {
			const result = invokeHandler(handlers, "context", {
				type: "context",
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}) as { messages: Array<Record<string, unknown>> };
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].role).toBe("user");
		}
	});

	it("does not inject before the turn threshold is reached", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);
		emitPending(handlers, "t-1");

		// Turns 1 and 2: threshold is 3, so no reminder yet.
		const r1 = fireContext(handlers, "t-1");
		expect(r1.messages).toHaveLength(1);
		const r2 = fireContext(handlers, "t-1");
		expect(r2.messages).toHaveLength(1);
	});

	it("injects a single trailing user reminder once the threshold is reached", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);
		emitPending(handlers, "t-1");

		fireContext(handlers, "t-1"); // turn 1
		fireContext(handlers, "t-1"); // turn 2
		const r3 = fireContext(handlers, "t-1"); // turn 3 -> fires

		expect(r3.messages).toHaveLength(2);
		const reminder = r3.messages[1];
		expect(reminder.role).toBe("user");
		const text = (reminder.content as Array<{ type: string; text: string }>)[0].text;
		expect(text).toContain("tool-result-pending-replacement");
		expect(text).toContain("replace_tool_result");
		expect(typeof reminder.timestamp).toBe("number");
	});

	it("never injects twice in the same round", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);
		emitPending(handlers, "t-1");

		fireContext(handlers, "t-1"); // 1
		fireContext(handlers, "t-1"); // 2
		const r3 = fireContext(handlers, "t-1"); // 3 -> fires
		expect(r3.messages).toHaveLength(2);

		// Subsequent turns must NOT add another reminder.
		const r4 = fireContext(handlers, "t-1");
		expect(r4.messages).toHaveLength(1);
		const r5 = fireContext(handlers, "t-1");
		expect(r5.messages).toHaveLength(1);
	});

	it("does not inject when all pending results have been replaced", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);
		emitPending(handlers, "t-1");

		// Replace before the threshold — no reminder should ever fire.
		await invokeTool(tools, "replace_tool_result", "llm-1", {
			toolCallId: "t-1",
			replacement: "done",
		});

		for (let i = 0; i < 5; i++) {
			const r = fireContext(handlers, "t-1");
			// Only the (swapped) tool result; no appended reminder.
			expect(r.messages).toHaveLength(1);
		}
	});

	it("resets across rounds (before_agent_start re-arms the latch)", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);
		emitPending(handlers, "t-1");

		// Fire the reminder in round 1.
		fireContext(handlers, "t-1"); // 1
		fireContext(handlers, "t-1"); // 2
		const r3 = fireContext(handlers, "t-1"); // 3 -> fires
		expect(r3.messages).toHaveLength(2);

		// New round: before_agent_start resets the latch.
		invokeHandler(handlers, "before_agent_start", {
			type: "before_agent_start",
			prompt: "next round",
			images: undefined,
			systemPrompt: "base",
			systemPromptOptions: { cwd: "/x" },
		});

		// Round 2: reminder can fire again after the threshold.
		fireContext(handlers, "t-1"); // 1
		fireContext(handlers, "t-1"); // 2
		const r3b = fireContext(handlers, "t-1"); // 3 -> fires again
		expect(r3b.messages).toHaveLength(2);
		expect(r3b.messages[1].role).toBe("user");
	});

	it("appends the reminder as the LAST message", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);
		emitPending(handlers, "t-1");

		fireContext(handlers, "t-1"); // 1
		fireContext(handlers, "t-1"); // 2

		// A context event whose last message is an assistant message — the
		// reminder must land after it, as the new tail.
		const result = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{
					role: "toolResult",
					toolCallId: "t-1",
					toolName: "bash",
					content: [{ type: "text", text: LONG }],
					isError: false,
				},
				{ role: "assistant", content: [{ type: "text", text: "thinking" }] },
			],
		}) as { messages: Array<Record<string, unknown>> };

		expect(result.messages).toHaveLength(3);
		expect(result.messages[2].role).toBe("user");
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
			"you MUST call `replace_tool_result({ items: [{ toolCallId, replacement }, ...] })` once you have",
		);
		expect(result.systemPrompt).toContain(
			"Replacement is a completion step of extraction, not optional cleanup",
		);
		expect(result.systemPrompt).toContain(
			"Do not let size become a reason to keep the full original around",
		);
		expect(result.systemPrompt).toContain("replace it before moving on");
		// The pre-answer sweep gate (option B) is present.
		expect(result.systemPrompt).toContain("Before you write your final answer, do the sweep");
		expect(result.systemPrompt).toContain(
			"Having the answer ready is no reason to leave them",
		);
		expect(result.systemPrompt).toContain("the sweep is a no-op");
		// Size-gate language was removed — these phrases must NOT appear.
		expect(result.systemPrompt).not.toContain("strictly shorter than the original");
		expect(result.systemPrompt).not.toContain("configured ratio");
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
			"you MUST call `replace_tool_result({ items: [{ toolCallId, replacement }, ...] })` once you have",
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
// -----------------------------------------------------------------------
// calibration (context snapshot + message_end) tests
// -----------------------------------------------------------------------
describe("divisor calibration", () => {
	it("recalibrates the divisor from message_end usage and changes later markers", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		// 1. A `context` event with 4000 chars of message content snapshots
		//    the character count for the prompt pi is about to send.
		const contextEvent = {
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "y".repeat(4000) }] },
			],
		};
		invokeHandler(handlers, "context", contextEvent);

		// 2. The model reports 2000 actual input tokens for that prompt → the
		//    true chars-per-token is 2, not the default 4. First sample has
		//    alpha = 1, so the divisor jumps to 2.
		invokeHandler(handlers, "message_end", {
			type: "message_end",
			message: { role: "assistant", usage: { input: 2000 } },
		});

		// 3. A fresh tool result of 4000 chars is now estimated with the
		//    calibrated divisor 2 → ceil(4000/2) = 2000 tokens in its marker,
		//    not the 1000 the default divisor would have produced.
		const result = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "bash-cal",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(4000) }],
			isError: false,
		});

		expect(result).toBeDefined();
		const content = (result as { content: Array<{ type: string; text: string }> }).content;
		expect(content[1].text).toMatch(
			/^\[tool-result-pending-replacement: toolCallId=bash-cal, tokens=2000\]$/,
		);
	});

	it("does not calibrate when TOOLCLIP_CALIBRATE=false (marker stays at default divisor)", () => {
		const { handlers, pi } = createMockApi();
		const prev = process.env.TOOLCLIP_CALIBRATE;
		process.env.TOOLCLIP_CALIBRATE = "false";
		try {
			toolclip(pi as never);

			// Snapshot + message_end would normally move the divisor.
			invokeHandler(handlers, "context", {
				type: "context",
				messages: [{ role: "user", content: "y".repeat(4000) }],
			});
			invokeHandler(handlers, "message_end", {
				type: "message_end",
				message: { role: "assistant", usage: { input: 2000 } },
			});

			// 4010 chars still estimated with divisor 4 → 1003 tokens (and above
			// the 1000 threshold, so a marker is emitted). Without calibration the
			// divisor stays pinned at the default.
			const result = invokeHandler(handlers, "tool_result", {
				type: "tool_result",
				toolCallId: "bash-cal2",
				toolName: "bash",
				content: [{ type: "text", text: "x".repeat(4010) }],
				isError: false,
			});
			const content = (result as { content: Array<{ type: string; text: string }> }).content;
			expect(content[1].text).toMatch(
				/^\[tool-result-pending-replacement: toolCallId=bash-cal2, tokens=1003\]$/,
			);
		} finally {
			if (prev === undefined) {
				delete process.env.TOOLCLIP_CALIBRATE;
			} else {
				process.env.TOOLCLIP_CALIBRATE = prev;
			}
		}
	});
});

// -----------------------------------------------------------------------
// calibration scope + clamp (golden-sample regression) tests
// -----------------------------------------------------------------------
describe("divisor calibration scope and clamp", () => {
	it("uses input + cacheRead + cacheWrite as the denominator", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		// 4000 message chars snapshotted for the prompt.
		invokeHandler(handlers, "context", {
			type: "context",
			messages: [{ role: "user", content: [{ type: "text", text: "y".repeat(4000) }] }],
		});

		// The provider reports input=500 with 1400 cached-read and 100
		// cache-write tokens. input alone would give an observed divisor of 8
		// (4000/500); the TOTAL prompt is 2000 tokens → true divisor 2.
		invokeHandler(handlers, "message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 500, cacheRead: 1400, cacheWrite: 100 },
			},
		});

		// Marker must use divisor 2 → ceil(4000/2) = 2000 tokens.
		const result = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "bash-cache",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(4000) }],
			isError: false,
		});
		const content = (result as { content: Array<{ type: string; text: string }> }).content;
		expect(content[1].text).toMatch(
			/^\[tool-result-pending-replacement: toolCallId=bash-cache, tokens=2000\]$/,
		);
	});

	it("counts the system prompt + tool defs in the numerator, and clamps at MAX", () => {
		const { handlers, pi } = createMockApi();
		// A huge system prompt (and a tool schema); the inactive tool must be
		// excluded from the overhead.
		pi.getActiveTools = () => ["read"];
		pi.getAllTools = () => [
			{
				name: "read",
				description: "d".repeat(500),
				parameters: { type: "object" },
			},
			{
				name: "inactive-tool",
				description: "z".repeat(100000),
				parameters: {},
			},
		] as never;
		toolclip(pi as never);

		// Round starts with a 100k-char system prompt → overhead ≥ 100k.
		invokeHandler(handlers, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "S".repeat(100000),
		});

		// 4000 message chars against 1000 total tokens → observed ≥ 104
		// without overhead accounting; with overhead included the observed
		// ratio is far above 8, so the clamp must hold the divisor at MAX.
		invokeHandler(handlers, "context", {
			type: "context",
			messages: [{ role: "user", content: [{ type: "text", text: "y".repeat(4000) }] }],
		});
		invokeHandler(handlers, "message_end", {
			type: "message_end",
			message: { role: "assistant", usage: { input: 1000 } },
		});

		// Divisor 8 → ceil(9000/8) = 1125 tokens (a divisor-4 estimate would
		// have produced 2250, and without overhead accounting divisor 4 would
		// apply to 4000 chars → 1000 → no marker at all).
		const result = invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "bash-overhead",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(9000) }],
			isError: false,
		});
		const content = (result as { content: Array<{ type: string; text: string }> }).content;
		expect(content[1].text).toMatch(
			/^\[tool-result-pending-replacement: toolCallId=bash-overhead, tokens=1125\]$/,
		);
	});
});
