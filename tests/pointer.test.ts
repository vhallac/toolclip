/**
 * Pointer mode tests: the replacement text kept exactly once (in the
 * replace call's arguments), the swapped original becoming a pointer
 * naming that call and its receipt.
 *
 * Covers lib/receipt.ts (minting), the replace tool's echo + details, the
 * context handler's pointer branch (applied, fallen back, re-pointed), the
 * copy-mode A/B baseline, and the config interactions (mode-shifted expiry
 * defaults, explicit env winning, tag length 0).
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import toolclip from "../src/toolclip.ts";
import { createMockApi, invokeHandler, invokeTool } from "./_helpers/mock-pi.ts";
import type { MockApi } from "./_helpers/mock-pi.ts";
import {
	createReceiptState,
	randomBase36Tag,
	formatReceiptId,
	mintReceipt,
} from "../lib/receipt.ts";
import { loadToolclipConfig } from "../lib/toolclip-config.ts";
import { buildReplacedPointer } from "../lib/marker.ts";

const LONG = "x".repeat(9000); // 5776 tokens estimated — above the 1000-token threshold

afterEach(() => {
	vi.unstubAllEnvs();
});

/** Emit a pending long result and store a replacement for it via toolCallId `callId`. */
async function replaceResult(
	{ handlers, tools }: Pick<MockApi, "handlers" | "tools">,
	toolCallId: string,
	callId: string,
	replacement = "short summary",
) {
	invokeHandler(handlers, "tool_result", {
		type: "tool_result",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: LONG }],
		isError: false,
	});
	return (await invokeTool(tools, "replace_tool_result", callId, {
		items: [{ toolCallId, replacement }],
	})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
}

describe("lib/receipt.ts", () => {
	it("generates a base36 tag of the requested length; 0 disables it", () => {
		for (const tag of [randomBase36Tag(3), randomBase36Tag(3), randomBase36Tag(3)]) {
			expect(tag).toMatch(/^[0-9a-z]{3}$/);
		}
		expect(randomBase36Tag(0)).toBe("");
		expect(randomBase36Tag(-1)).toBe("");
	});

	it("formats receipt ids as prefix + tag + '-' + counter (empty tag → prefix-counter)", () => {
		expect(formatReceiptId("rp", "7k2", 3)).toBe("rp7k2-3");
		expect(formatReceiptId("rp", "", 12)).toBe("rp-12");
	});

	it("mints one receipt per storing call, incrementing the counter", () => {
		const rs = createReceiptState(0); // tag disabled → deterministic ids
		expect(mintReceipt(rs, "rp")).toBe("rp-1");
		expect(mintReceipt(rs, "rp")).toBe("rp-2");
		expect(rs.counter).toBe(2);
	});
});

describe("replace_tool_result receipt (pointer mode, the default)", () => {
	it("stamps the echo header with the receipt and the call id; details carry mode/receipt/replaceCallId", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		const result = await replaceResult({ handlers, tools }, "bash-1", "call_A");

		const receiptId = result.details.receiptId as string;
		expect(result.details.mode).toBe("pointer");
		expect(result.details.replaceCallId).toBe("call_A");
		expect(receiptId).toMatch(/^rp[a-z0-9]{3}-1$/);
		expect(result.content[0].text).toContain(
			`Receipt ${receiptId}: stored 1 replacement (call call_A). ` +
				"Originals are swapped for a pointer to this call's arguments in subsequent LLM calls:",
		);
		// Per-item lines unchanged.
		expect(result.content[0].text).toContain("  - bash-1: 2 tokens (was 5776)");
	});

	it("one call storing two items: one receipt, both originals point at the same call", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		for (const id of ["x", "y"]) {
			invokeHandler(handlers, "tool_result", {
				type: "tool_result",
				toolCallId: id,
				toolName: "bash",
				content: [{ type: "text", text: LONG }],
				isError: false,
			});
		}
		const result = (await invokeTool(tools, "replace_tool_result", "call_A", {
			items: [
				{ toolCallId: "x", replacement: "summary x" },
				{ toolCallId: "y", replacement: "summary y" },
			],
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
		const receiptId = result.details.receiptId as string;
		expect(result.details.replaceCallId).toBe("call_A");

		const ctx = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_A", name: "replace_tool_result", arguments: {} },
					],
				},
				{
					role: "toolResult",
					toolCallId: "x",
					toolName: "bash",
					content: [{ type: "text", text: "original x" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "y",
					toolName: "bash",
					content: [{ type: "text", text: "original y" }],
					isError: false,
				},
			],
		}) as { messages: Array<{ content: Array<{ text: string }> }> };

		expect(ctx.messages[1].content[0].text).toBe(
			`[tool-result-replaced: toolCallId=x; summary is the replacement text for this id in your replace_tool_result call call_A, receipt ${receiptId}]`,
		);
		expect(ctx.messages[2].content[0].text).toBe(
			`[tool-result-replaced: toolCallId=y; summary is the replacement text for this id in your replace_tool_result call call_A, receipt ${receiptId}]`,
		);
		// The call's own result (the receipt echo) is never swapped.
		expect(ctx.messages[0].content).toHaveLength(1);
	});

	it("mints sequential receipts per storing call, and none for a nothing-stored call", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		const first = await replaceResult({ handlers, tools }, "bash-1", "call_1");
		expect(first.details.receiptId).toMatch(/-1$/);

		// A call naming only an unknown id stores nothing: no receipt, and
		// the counter is NOT consumed (the next receipt keeps its number).
		const nothing = (await invokeTool(tools, "replace_tool_result", "call_2", {
			items: [{ toolCallId: "no-such-id", replacement: "ghost" }],
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
		expect(nothing.details.receiptId).toBeUndefined();
		expect(nothing.details.replaceCallId).toBeUndefined();
		expect(nothing.details.mode).toBe("pointer");
		expect(nothing.content[0].text).toBe("Skipped 1 unknown id: no-such-id");

		const third = await replaceResult({ handlers, tools }, "bash-2", "call_3");
		expect(third.details.receiptId).toMatch(/-2$/);
	});

	it("re-replacement overwrites the entry's call identity and receipt", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		await replaceResult({ handlers, tools }, "bash-1", "call_1");
		const second = (await invokeTool(tools, "replace_tool_result", "call_2", {
			items: [{ toolCallId: "bash-1", replacement: "tighter summary" }],
		})) as { details: Record<string, unknown> };

		expect(second.details.receiptId).toMatch(/-2$/);
		expect(second.details.replaceCallId).toBe("call_2");

		// The pointer now names the newest call only.
		const ctx = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_1", name: "replace_tool_result", arguments: {} },
						{ type: "toolCall", id: "call_2", name: "replace_tool_result", arguments: {} },
					],
				},
				{
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: [{ type: "text", text: "original" }],
					isError: false,
				},
			],
		}) as { messages: Array<{ content: Array<{ text: string }> }> };

		const receipt2 = second.details.receiptId as string;
		expect(ctx.messages[1].content).toHaveLength(1);
		expect(ctx.messages[1].content[0].text).toBe(
			`[tool-result-replaced: toolCallId=bash-1; summary is the replacement text for this id in your replace_tool_result call call_2, receipt ${receipt2}]`,
		);
	});
});

describe("context handler — pointer mode", () => {
	it("swaps the original for a ONE-block pointer when the replace call is present", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		const stored = await replaceResult({ handlers, tools }, "bash-1", "call_A");
		const receiptId = stored.details.receiptId as string;

		const ctx = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "go" }] },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_A", name: "replace_tool_result", arguments: {} },
					],
				},
				{
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: [{ type: "text", text: "original content" }],
					isError: false,
				},
			],
		}) as { messages: Array<{ role: string; content: Array<{ text: string }> }> };

		// ONE block; the replacement text is NOT duplicated, no separate marker.
		expect(ctx.messages[2].content).toHaveLength(1);
		expect(ctx.messages[2].content[0].text).toBe(
			`[tool-result-replaced: toolCallId=bash-1; summary is the replacement text for this id in your replace_tool_result call call_A, receipt ${stored.details.receiptId}]`,
		);
		expect(receiptId).toBeTruthy();
	});

	it("falls back to the copy swap when the replace call is not in the messages", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		const stored = await replaceResult({ handlers, tools }, "bash-1", "call_A");
		// Only an UNRELATED replace call is present.
		const ctx = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "some_other_call", name: "replace_tool_result", arguments: {} },
					],
				},
				{
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: [{ type: "text", text: "original content" }],
					isError: false,
				},
			],
		}) as { messages: Array<{ content: Array<{ text: string }> }> };

		// Pointer must never dangle: the copy form is used.
		expect(ctx.messages[1].content).toHaveLength(2);
		expect(ctx.messages[1].content[0].text).toBe("short summary");
		expect(ctx.messages[1].content[1].text).toBe("[tool-result-replaced: toolCallId=bash-1]");
		void stored;
	});

	it("drops the call id from the pointer when TOOLCLIP_POINTER_INCLUDE_CALL_ID is false", async () => {
		vi.stubEnv("TOOLCLIP_POINTER_INCLUDE_CALL_ID", "false");
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		const stored = await replaceResult({ handlers, tools }, "bash-1", "call_A");
		const receiptId = stored.details.receiptId as string;

		const ctx = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_A", name: "replace_tool_result", arguments: {} },
					],
				},
				{
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: [{ type: "text", text: "original" }],
					isError: false,
				},
			],
		}) as { messages: Array<{ content: Array<{ text: string }> }> };

		expect(ctx.messages[1].content[0].text).toBe(
			`[tool-result-replaced: toolCallId=bash-1; summary is the replacement text for this id in your replace_tool_result call, receipt ${receiptId}]`,
		);
	});

	it("keeps the replaced-marker prefix identical for traceability greps", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		const stored = await replaceResult({ handlers, tools }, "bash-1", "call_A");
		const ctx = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_A", name: "replace_tool_result", arguments: {} },
					],
				},
				{
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: [{ type: "text", text: "original" }],
					isError: false,
				},
			],
		}) as { messages: Array<{ content: Array<{ text: string }> }> };

		const text = ctx.messages[1].content[0].text;
		expect(text.startsWith("[tool-result-replaced: toolCallId=bash-1")).toBe(true);
		expect(text).toContain(stored.details.receiptId as string);
	});
});

describe("copy mode (TOOLCLIP_REPLACEMENT_MODE=copy) — the A/B baseline", () => {
	it("keeps today's echo header and two-block swap; details still carry mode+receipt", async () => {
		vi.stubEnv("TOOLCLIP_REPLACEMENT_MODE", "copy");
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		const stored = await replaceResult({ handlers, tools }, "bash-1", "call_A");
		expect(stored.details.mode).toBe("copy");
		expect(stored.details.receiptId).toMatch(/-1$/);
		expect(stored.content[0].text).toContain(
			"Stored 1 replacement. Originals will be swapped in subsequent LLM calls:",
		);
		expect(stored.content[0].text).not.toContain("Receipt");

		// Even with the call present, copy mode uses the copy swap.
		const ctx = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_A", name: "replace_tool_result", arguments: {} },
					],
				},
				{
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: [{ type: "text", text: "original" }],
					isError: false,
				},
			],
		}) as { messages: Array<{ content: Array<{ text: string }> }> };

		expect(ctx.messages[1].content).toHaveLength(2);
		expect(ctx.messages[1].content[0].text).toBe("short summary");
		expect(ctx.messages[1].content[1].text).toBe("[tool-result-replaced: toolCallId=bash-1]");
	});
});

describe("system prompt — pointer paragraph", () => {
	it("appends the pointer reading instructions only in pointer mode", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const result = invokeHandler(handlers, "before_agent_start", {
			type: "before_agent_start",
			prompt: "x",
			images: undefined,
			systemPrompt: "base",
			systemPromptOptions: { cwd: "/x" },
		}) as { systemPrompt: string };

		expect(result.systemPrompt).toContain(
			"A replaced result is shown as [tool-result-replaced: toolCallId=...; ... receipt R].",
		);
		expect(result.systemPrompt).toContain("Do not re-run the tool to recover it.");
	});

	it("omits the pointer paragraph in copy mode", () => {
		vi.stubEnv("TOOLCLIP_REPLACEMENT_MODE", "copy");
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);

		const result = invokeHandler(handlers, "before_agent_start", {
			type: "before_agent_start",
			prompt: "list files",
			images: undefined,
			systemPrompt: "base",
			systemPromptOptions: { cwd: "/x" },
		}) as { systemPrompt: string };

		expect(result.systemPrompt).not.toContain("receipt R");
		expect(result.systemPrompt).toContain("## Tool Result Replacement");
	});
});

describe("config — replacement mode parameters", () => {
	it("copy mode restores the expiry COPIES/OVERHEAD defaults (2/60)", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_REPLACEMENT_MODE: "copy",
		} as NodeJS.ProcessEnv);
		expect(config.replacementMode).toBe("copy");
		expect(config.expiryReplacementCopies).toBe(2);
		expect(config.expiryOverheadTokens).toBe(60);
	});

	it("pointer mode shifts the expiry defaults to 1/95; explicit env values win", () => {
		const config = loadToolclipConfig({} as NodeJS.ProcessEnv);
		expect(config.replacementMode).toBe("pointer");
		expect(config.expiryReplacementCopies).toBe(1);
		expect(config.expiryOverheadTokens).toBe(95);

		const explicit = loadToolclipConfig({
			TOOLCLIP_EXPIRY_REPLACEMENT_COPIES: "3",
			TOOLCLIP_EXPIRY_OVERHEAD_TOKENS: "50",
		} as NodeJS.ProcessEnv);
		expect(explicit.expiryReplacementCopies).toBe(3);
		expect(explicit.expiryOverheadTokens).toBe(50);
	});

	it("treats any mode value other than copy as the pointer default", () => {
		for (const value of [undefined, "", "pointer", "Pointer", "bogus"]) {
			const config = loadToolclipConfig(
				value === undefined
					? ({} as NodeJS.ProcessEnv)
					: ({ TOOLCLIP_REPLACEMENT_MODE: value } as NodeJS.ProcessEnv),
			);
			expect(config.replacementMode).toBe("pointer");
		}
	});

	it("honors receipt prefix and tag length env vars; 0 disables the tag", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_RECEIPT_PREFIX: "rx",
			TOOLCLIP_RECEIPT_TAG_LENGTH: "0",
		} as NodeJS.ProcessEnv);
		expect(config.receiptPrefix).toBe("rx");
		expect(config.receiptTagLength).toBe(0);

		const bad = loadToolclipConfig({
			TOOLCLIP_RECEIPT_TAG_LENGTH: "-1",
		} as NodeJS.ProcessEnv);
		expect(bad.receiptTagLength).toBe(3);
	});

	it("falls back to the default receipt prefix for an empty value", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_RECEIPT_PREFIX: "",
		} as NodeJS.ProcessEnv);
		expect(config.receiptPrefix).toBe("rp");
	});
});

describe("receipt tag — resume uniqueness", () => {
	it("formats with the configured prefix and tag length via the extension (tag 0 → deterministic ids)", async () => {
		vi.stubEnv("TOOLCLIP_RECEIPT_TAG_LENGTH", "0");
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);

		const stored = await replaceResult({ handlers, tools }, "bash-1", "call_A");
		// No tag: prefix + "-" + counter — "rp-1".
		expect(stored.details.receiptId).toBe("rp-1");
		expect(stored.content[0].text).toContain("Receipt rp-1: stored 1 replacement (call call_A).");
	});
});

describe("buildReplacedPointer", () => {
	it("matches the spec format with and without the call id", () => {
		expect(buildReplacedPointer("x", "call_A", "rp7k2-1", true)).toBe(
			"[tool-result-replaced: toolCallId=x; summary is the replacement text for this id in your replace_tool_result call call_A, receipt rp7k2-1]",
		);
		expect(buildReplacedPointer("x", "call_A", "rp7k2-1", false)).toBe(
			"[tool-result-replaced: toolCallId=x; summary is the replacement text for this id in your replace_tool_result call, receipt rp7k2-1]",
		);
	});
});