import { describe, expect, it, vi, afterEach } from "vitest";
import toolclip from "../src/toolclip.ts";
import { createMockApi, invokeHandler, invokeTool } from "./_helpers/mock-pi.ts";
import type { Handler, SteeredMessage } from "./_helpers/mock-pi.ts";

// -----------------------------------------------------------------------
// tool_result event handler tests
// -----------------------------------------------------------------------
describe("tool_result handler", () => {
	it("appends a pending marker to a result above the token threshold", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		// tokenx: 1286 + 4490 space-free counterweight = 5776 tokens — just above the 1000 default.
		const longText = "x".repeat(9000);
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
			/^\[tool-result-pending-replacement: toolCallId=read-1, tokens=5776\]$/,
		);
	});

	it("does NOT append a marker to a result at or below the token threshold", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		// tokenx: 72 + 240 space-free counterweight = 312 tokens — well below
		// the 1000 default. Small results are too cheap to distill; marking
		// them wastes budget.
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

			// tokenx: 143 + 490 space-free counterweight = 633 tokens > 100 threshold → marked.
			const shortText = "x".repeat(1000);
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
			expect(content[1].text).toContain("tokens=633");
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

		const block1 = "x".repeat(6000);  // tokenx: 858 + 2990 counterweight = 3848 tokens
		const block2 = "y".repeat(6004);  // tokenx: 858 + 2992 counterweight = 3850 tokens
		// Total: 7698 tokens — above the 1000 default.
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
		expect(content[2].text).toContain("tokens=7698");
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

		// tokenx: 3 tokens — non-zero but below the 1000
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
// re-read observation tests (toolclipReread in read-result details)
// -----------------------------------------------------------------------
describe("re-read observation (toolclipReread details)", () => {
	const LONG = "x".repeat(9000); // 5776 tokens estimated — above the 1000 threshold
	const SHORT = "x".repeat(500); // below the threshold

	function readEvent(toolCallId: string, path: string, text = LONG, extra: Record<string, unknown> = {}) {
		return {
			type: "tool_result",
			toolCallId,
			toolName: "read",
			input: { path },
			content: [{ type: "text", text }],
			isError: false,
			...extra,
		};
	}

	it("first read of a path attaches no details", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const result = invokeHandler(handlers, "tool_result", readEvent("r-1", "/a.ts")) as {
			content?: unknown;
			details?: unknown;
		};

		expect(result).toBeDefined();
		expect(result.content).toBeDefined(); // marker appended
		expect(result.details).toBeUndefined();
	});

	it("second read of the same path attaches toolclipReread with count 2", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", readEvent("r-1", "/a.ts"));
		const result = invokeHandler(handlers, "tool_result", readEvent("r-2", "/a.ts")) as {
			details: { toolclipReread: { path: string; count: number } };
		};

		expect(result.details.toolclipReread).toEqual({ path: "/a.ts", count: 2 });
	});

	it("counts non-consecutive re-reads across the round (3rd read → count 3)", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", readEvent("r-1", "/a.ts"));
		// A different path in between — the counter must not reset.
		invokeHandler(handlers, "tool_result", readEvent("r-2", "/b.ts"));
		invokeHandler(handlers, "tool_result", readEvent("r-3", "/a.ts"));
		const result = invokeHandler(handlers, "tool_result", readEvent("r-4", "/a.ts")) as {
			details: { toolclipReread: { path: string; count: number } };
		};

		expect(result.details.toolclipReread).toEqual({ path: "/a.ts", count: 3 });
	});

	it("different paths are tracked independently", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", readEvent("r-1", "/a.ts"));
		const result = invokeHandler(handlers, "tool_result", readEvent("r-2", "/b.ts")) as {
			details?: unknown;
		};

		expect(result.details).toBeUndefined();
	});

	it("a below-threshold re-read gets a details-only result (content untouched)", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", readEvent("r-1", "/small.ts", SHORT));
		const result = invokeHandler(handlers, "tool_result", readEvent("r-2", "/small.ts", SHORT)) as {
			content?: unknown;
			details?: { toolclipReread: { path: string; count: number } };
		};

		// No pending marker (below threshold), but the re-read is still flagged.
		expect(result.content).toBeUndefined();
		expect(result.details?.toolclipReread).toEqual({ path: "/small.ts", count: 2 });
	});

	it("failed reads (isError) are not counted", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", readEvent("r-err", "/a.ts", LONG, { isError: true }));
		const result = invokeHandler(handlers, "tool_result", readEvent("r-2", "/a.ts")) as {
			details?: unknown;
		};

		// The error read did not consume the first-read slot.
		expect(result.details).toBeUndefined();
	});

	it("non-read tools are not tracked", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const grepEvent = {
			type: "tool_result",
			toolCallId: "g-1",
			toolName: "grep",
			input: { pattern: "x", path: "/a.ts" },
			content: [{ type: "text", text: LONG }],
			isError: false,
		};
		invokeHandler(handlers, "tool_result", grepEvent);
		const result = invokeHandler(handlers, "tool_result", { ...grepEvent, toolCallId: "g-2" }) as {
			details?: unknown;
		};

		expect(result.details).toBeUndefined();
	});

	it("merges into existing event details instead of replacing them", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", readEvent("r-1", "/a.ts"));
		const result = invokeHandler(
			handlers,
			"tool_result",
			readEvent("r-2", "/a.ts", LONG, { details: { truncation: { truncated: true } } }),
		) as {
			details: Record<string, unknown>;
		};

		expect(result.details.truncation).toEqual({ truncated: true });
		expect(result.details.toolclipReread).toEqual({ path: "/a.ts", count: 2 });
	});

	it("resets the per-round counter at before_agent_start", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", readEvent("r-1", "/a.ts"));
		invokeHandler(handlers, "tool_result", readEvent("r-2", "/a.ts")); // count 2

		invokeHandler(handlers, "before_agent_start", {
			type: "before_agent_start",
			prompt: "next round",
			images: undefined,
			systemPrompt: "base",
			systemPromptOptions: { cwd: "/x" },
		});

		// New round: the same path is a first read again.
		const result = invokeHandler(handlers, "tool_result", readEvent("r-3", "/a.ts")) as {
			details?: unknown;
		};
		expect(result.details).toBeUndefined();
	});
});

// -----------------------------------------------------------------------
// replace_tool_result tool tests
// -----------------------------------------------------------------------
describe("replace_tool_result tool", () => {
	it("accepts a single-pair array and records the replacement (grew=false)", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		// Emit a tool result to create a pending entry (5776 tokens estimated, above threshold)
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-1",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(9000) }],
			isError: false,
		});

		const result = (await invokeTool(tools, "replace_tool_result", "tool-1", {
			items: [{ toolCallId: "tool-1", replacement: "short summary" }],
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

		expect(result.details).toMatchObject({ ok: true });
		const r0 = (result.details.results as Array<Record<string, unknown>>)[0];
		expect(r0).toMatchObject({ toolCallId: "tool-1", ok: true });
		expect(r0.originalTokens).toBe(5776);
		expect(r0.replacementTokens).toBe(2); // tokenx("short summary")
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
			content: [{ type: "text", text: "x".repeat(9000) }],
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

		// 5133 tokens estimated (tokenx 1143 + 3990 counterweight) — above threshold
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-grew",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(8000) }],
			isError: false,
		});

		// 5390 tokens estimated > 5133 original — previously hard-failed.
		const result = (await invokeTool(tools, "replace_tool_result", "tool-grew", {
			items: [{ toolCallId: "tool-grew", replacement: "x".repeat(8400) }],
		})) as { details: Record<string, unknown> };

		const r0 = (result.details.results as Array<Record<string, unknown>>)[0];
		expect(r0).toMatchObject({ ok: true });
		expect(r0.originalTokens).toBe(5133);
		expect(r0.replacementTokens).toBe(5390);
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

		// 312 tokens vs 5133 original — accepted (the old 0.1 ratio and the
		// 1000-token "worth replacing" floor are both gone).
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
			content: [{ type: "text", text: "x".repeat(9000) }],
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
		expect(r2.replacementTokens).toBe(1); // tokenx("v2")
	});

	it("handles zero-length replacement (0 tokens)", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "tool-zero",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(9000) }],
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
			content: [{ type: "text", text: "x".repeat(9000) }],
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

		// Emit a long tool result and replace it (5776 tokens estimated, above threshold)
		invokeHandler(handlers, "tool_result", {
			type: "tool_result",
			toolCallId: "replaced-1",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(9000) }],
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
// steering reminder tests (turn_end → pi-native steer via sendUserMessage)
// -----------------------------------------------------------------------
// -----------------------------------------------------------------------
// steering reminder tests (turn_end → pi-native steer via sendUserMessage)
// -----------------------------------------------------------------------
describe("steering reminder delivery", () => {
	const LONG = "x".repeat(9000); // 5776 tokens estimated — above the 1000-token threshold

	afterEach(() => {
		vi.unstubAllEnvs();
	});

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

	// Helper: fire a context event whose messages carry toolResult entries
	// for the given ids — what the model most recently saw. Steering
	// eligibility is defined against this set, so a turn_end observation
	// counts only entries present in the most recent context event. A
	// result marked after this event (during the current turn) is not
	// eligible until a later context event includes it.
	function runContext(handlers: Map<string, Handler[]>, ids: string[]): void {
		invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				...ids.map((toolCallId) => ({
					role: "toolResult",
					toolCallId,
					toolName: "bash",
					content: [{ type: "text", text: LONG }],
					isError: false,
				})),
			],
		});
	}

	// Helper: fire a turn_end — the steering observation point. At a real
	// turn boundary pi polls the steering queue right after this event, so
	// whatever the handler enqueues via sendUserMessage is delivered here.
	function runTurnEnd(handlers: Map<string, Handler[]>, turnIndex = 0): void {
		invokeHandler(handlers, "turn_end", {
			type: "turn_end",
			turnIndex,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
	}

	// Helper: the single steered reminder's text.
	function steeredText(steers: SteeredMessage[]): string {
		expect(steers).toHaveLength(1);
		expect(typeof steers[0].content).toBe("string");
		return steers[0].content as string;
	}

	it("delivers the reminder via pi-native steering (deliverAs: steer)", () => {
		const { handlers, pi, steers } = createMockApi();
		toolclip(pi as never);
		emitPending(handlers, "huge-1");

		// The mark is not eligible until the model has seen it in a context
		// event: at the mark's own turn boundary the pile does not count.
		runTurnEnd(handlers);
		expect(steers).toHaveLength(0);

		// One eligible pending of ~5776 estimated tokens has crossed the
		// first rung (5000): the golden-run single-huge-blob case.
		runContext(handlers, ["huge-1"]);
		runTurnEnd(handlers);
		const text = steeredText(steers);
		expect(text).toContain("1 tool-result-pending-replacements");
		expect(text).toContain("totalling ~5776 estimated tokens");
		expect(text).toContain("- huge-1 (~5776 tokens)");
		expect(text).toContain("replace_tool_result");
		expect(text).toContain("just in case");
		// Pi-native delivery: queued as a steer, so pi persists it as a real
		// user message at the next turn boundary.
		expect(steers[0].options).toEqual({ deliverAs: "steer" });
	});

	it("latches at a rung: no re-send while the mass stays put", () => {
		const { handlers, pi, steers } = createMockApi();
		toolclip(pi as never);
		emitPending(handlers, "huge-1");
		runContext(handlers, ["huge-1"]);

		runTurnEnd(handlers);
		expect(steers).toHaveLength(1);

		// The mass is unchanged (5776 has crossed exactly one rung and the
		// ratchet level is 1): further turn boundaries must not repeat the
		// nag — the persisted message is still in front of the model.
		for (let i = 0; i < 5; i++) {
			runTurnEnd(handlers, i + 1);
		}
		expect(steers).toHaveLength(1);
	});

	it("a multi-rung jump announces a single nag", () => {
		const { handlers, pi, steers } = createMockApi();
		toolclip(pi as never);
		const ids = ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"];
		for (const id of ids) emitPending(handlers, id);
		runContext(handlers, ids);

		// 6 x 5776 = 34,656 estimated tokens crosses FIVE rungs at once
		// (5000, 8000, 13000, 21000, 34000) — one nag announces them all.
		runTurnEnd(handlers);
		expect(steers).toHaveLength(1);
		const text = steeredText(steers);
		expect(text).toContain("6 tool-result-pending-replacements");
		expect(text).toContain("totalling ~34656 estimated tokens");
		for (const id of ids) {
			expect(text).toContain(`- ${id} (~5776 tokens)`);
		}

		// Same mass again: level 5, no further reminder.
		runTurnEnd(handlers, 1);
		expect(steers).toHaveLength(1);

		// Growth that stays within the announced rungs stays silent too
		// (9 x 5776 = 51,984 is still below rung 55,000).
		for (const id of ["t-7", "t-8", "t-9"]) {
			emitPending(handlers, id);
		}
		runContext(handlers, [...ids, "t-7", "t-8", "t-9"]);
		runTurnEnd(handlers, 2);
		expect(steers).toHaveLength(1);
	});

	it("a partial replacement re-arms the level down; a re-grown pile nags again", async () => {
		const { handlers, tools, pi, steers } = createMockApi();
		toolclip(pi as never);
		const ids = ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"];
		for (const id of ids) emitPending(handlers, id);
		runContext(handlers, ids);
		runTurnEnd(handlers);
		expect(steers).toHaveLength(1); // 34,656 tokens: level 5

		// Replace four: S drops to 11,552 — crossed 2 < level 5, so the
		// level re-arms down to 2 and no nag fires.
		for (const id of ["t-1", "t-2", "t-3", "t-4"]) {
			await invokeTool(tools, "replace_tool_result", "llm-1", {
				toolCallId: id,
				replacement: "distilled",
			});
		}
		runContext(handlers, ids); // the model still sees all six (4 swapped)
		runTurnEnd(handlers);
		expect(steers).toHaveLength(1); // no reminder
		expect(steeredText(steers)).toContain("6 tool-result-pending-replacements");

		// Re-grow the pile past an announced rung: the reminder fires again.
		for (const id of ["t-7", "t-8", "t-9"]) {
			emitPending(handlers, id);
		}
		runContext(handlers, ["t-5", "t-6", "t-7", "t-8", "t-9"]);
		runTurnEnd(handlers);
		expect(steers).toHaveLength(2);
		const text = steeredText(steers.slice(1));
		expect(text).toContain("5 tool-result-pending-replacements");
		expect(text).toContain("totalling ~28880 estimated tokens");
		expect(text).toContain("- t-9 (~5776 tokens)");
		// Replaced entries are gone from the list even though their ids are
		// still in the messages (swapped in place).
		expect(text).not.toContain("- t-1\n");
	});

	it("entries compacted away stop counting, without deleting their tracker entries", () => {
		const { handlers, pi, steers } = createMockApi();
		toolclip(pi as never);
		for (const id of ["a", "b"]) emitPending(handlers, id);
		runContext(handlers, ["a", "b"]);
		runTurnEnd(handlers);
		expect(steers).toHaveLength(1); // 11,552 tokens: crossed 2, level 2

		// "b" is compacted away: it is no longer in the messages, so it
		// stops counting (its tracker entry stays — nothing is deleted).
		runContext(handlers, ["a"]);
		runTurnEnd(handlers);
		expect(steers).toHaveLength(1); // 5,776: crossed 1 < 2 — re-armed, no nag

		// Re-grown pile: a + fresh c = 11,552 — crossed 2 > 1 — fires again,
		// and the nag lists only the eligible ids.
		emitPending(handlers, "c");
		runContext(handlers, ["a", "c"]);
		runTurnEnd(handlers);
		expect(steers).toHaveLength(2);
		const text = steeredText(steers.slice(1));
		expect(text).toContain("2 tool-result-pending-replacements");
		expect(text).toContain("- a (~5776 tokens)");
		expect(text).toContain("- c (~5776 tokens)");
		expect(text).not.toContain("- b");
	});

	it("does not steer when all pending results have been replaced", async () => {
		const { handlers, tools, pi, steers } = createMockApi();
		toolclip(pi as never);
		const ids = ["t-1", "t-2", "t-3", "t-4", "t-5"];
		for (const id of ids) emitPending(handlers, id);
		for (const id of ids) {
			await invokeTool(tools, "replace_tool_result", "llm-1", {
				toolCallId: id,
				replacement: "done",
			});
		}

		runContext(handlers, ids);
		for (let i = 0; i < 5; i++) {
			runTurnEnd(handlers, i);
		}
		expect(steers).toHaveLength(0);
	});

	it("re-announces a persistent pile at the first turn boundary of the next round", () => {
		const { handlers, pi, steers } = createMockApi();
		toolclip(pi as never);
		const ids = ["t-1", "t-2", "t-3", "t-4", "t-5"];
		for (const id of ids) emitPending(handlers, id);
		runContext(handlers, ids);

		// Fire the reminder in round 1.
		runTurnEnd(handlers);
		expect(steers).toHaveLength(1);

		// New round: before_agent_start resets the ratchet level.
		invokeHandler(handlers, "before_agent_start", {
			type: "before_agent_start",
			prompt: "next round",
			images: undefined,
			systemPrompt: "base",
			systemPromptOptions: { cwd: "/x" },
		});

		// The un-replaced pile is re-announced at the round's first turn
		// boundary — a fresh persisted reminder replaces the stale one.
		runTurnEnd(handlers, 1);
		expect(steers).toHaveLength(2);
		expect(steeredText(steers.slice(1))).toContain("5 tool-result-pending-replacements");
	});

	it("does not steer when TOOLCLIP_STEERING_REMINDER is false", () => {
		vi.stubEnv("TOOLCLIP_STEERING_REMINDER", "false");
		const { handlers, pi, steers } = createMockApi();
		toolclip(pi as never);
		const ids = ["t-1", "t-2"];
		for (const id of ids) emitPending(handlers, id);
		runContext(handlers, ids);

		for (let i = 0; i < 3; i++) {
			runTurnEnd(handlers, i);
		}
		expect(steers).toHaveLength(0);
	});

	it("never appends a reminder in the context handler (persistence is the steer's job)", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);
		const ids = ["t-1", "t-2"];
		for (const id of ids) emitPending(handlers, id);

		// The pile is above the rungs, but the context event must stay a
		// pure view transform: no synthetic trailing user message. The old
		// per-call append was consumed for exactly one LLM call and never
		// written to the session — that is the bug this path replaces. The
		// id-set recording is state-only.
		const event = {
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "run it" }] },
				{ role: "assistant", content: [{ type: "text", text: "thinking" }] },
				...ids.map((toolCallId) => ({
					role: "toolResult",
					toolCallId,
					toolName: "bash",
					content: [{ type: "text", text: LONG }],
					isError: false,
				})),
			],
		};

		const result = invokeHandler(handlers, "context", event) as {
			messages: Array<Record<string, unknown>>;
		};

		expect(result.messages).toHaveLength(4);
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[1].role).toBe("assistant");
		expect(result.messages[2].role).toBe("toolResult");
		expect(result.messages[3].role).toBe("toolResult");
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
			"you MUST replace it with `replace_tool_result({ items: [{ toolCallId, replacement }, ...] })`",
		);
		// The extract-all-then-replace method (read → extract ALL → replace).
		expect(result.systemPrompt).toContain("1. READ the result once, in full.");
		expect(result.systemPrompt).toContain(
			"2. EXTRACT all the information you may still need for the rest of the task",
		);
		expect(result.systemPrompt).toContain(
			"Not just what the next step needs: anything you might consult later goes in now",
		);
		expect(result.systemPrompt).toContain("3. REPLACE. The swap is irreversible");
		expect(result.systemPrompt).toContain(
			"recovering anything you failed to capture means re-running the tool at full cost",
		);
		expect(result.systemPrompt).toContain(
			"Replacement is a completion step of extraction, not optional cleanup",
		);
		expect(result.systemPrompt).toContain(
			"the extraction must be complete BEFORE you replace",
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
		// Useless results are replaced too: "nothing to extract" is the
		// extraction result, not a reason to defer.
		expect(result.systemPrompt).toContain("most important one to replace");
		expect(result.systemPrompt).toContain(
			"what the call checked and what it did and did not find",
		);
		// Size-gate language was removed — these phrases must NOT appear.
		expect(result.systemPrompt).not.toContain("strictly shorter than the original");
		expect(result.systemPrompt).not.toContain("configured ratio");
		// The old one-way-door wording must not come back.
		expect(result.systemPrompt).not.toContain(
			"the earlier you replace, the more context you save",
		);
		expect(result.systemPrompt).not.toContain(
			"as soon as you can derive the relevant information from a single result",
		);
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
			"you MUST replace it with `replace_tool_result({ items: [{ toolCallId, replacement }, ...] })`",
		);
		expect(result.systemPrompt).toContain("3. REPLACE. The swap is irreversible");
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
