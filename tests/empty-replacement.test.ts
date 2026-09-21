/**
 * Empty-replacement placeholder tests: an empty (or whitespace-only)
 * replacement means "the result was useless" — the placeholder text is
 * stored in place, the entry is never stamped (so the context swap uses the
 * in-place copy form, never a pointer), no receipt is minted for a call
 * that stores only placeholders, the echo marks the item line, a
 * placeholder never feeds the expiry R, and a substituted store still
 * resets the steering pile.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import toolclip from "../src/toolclip.ts";
import { createMockApi, invokeHandler, invokeTool } from "./_helpers/mock-pi.ts";
import type { MockApi } from "./_helpers/mock-pi.ts";
import { createRuntimeState, pendingIds, recordPending, recordReplacement, replacedIds } from "../lib/runtime-state.ts";
import { estimateTokens } from "../lib/tokens.ts";

const LONG = "x".repeat(9000); // 5776 tokens estimated — above the 1000-token threshold
// Big enough to survive the pay-back test next to LONG, but below the
// quarantine threshold (a quarantined result is never tracked).
const HUGE = "z".repeat(13400);

afterEach(() => {
	vi.unstubAllEnvs();
});

type ReplaceResult = {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
};

/** Emit a pending over-threshold result for `toolCallId`. */
function emitLong(
	{ handlers }: Pick<MockApi, "handlers">,
	toolCallId: string,
	text = LONG,
): void {
	invokeHandler(handlers, "tool_result", {
		type: "tool_result",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
	});
}

async function replace(
	{ tools }: Pick<MockApi, "tools">,
	callId: string,
	items: Array<{ toolCallId: string; replacement: string }>,
): Promise<ReplaceResult> {
	return (await invokeTool(tools, "replace_tool_result", callId, { items })) as ReplaceResult;
}

/** Run a context event carrying toolResult messages for the given ids. */
function runContext(
	{ handlers }: Pick<MockApi, "handlers">,
	ids: string[],
): { messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> } {
	return invokeHandler(handlers, "context", {
		type: "context",
		messages: ids.map((id) => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: "original" }],
			isError: false,
		})),
	}) as { messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> };
}

/** Run a turn_end with an assistant usage block (ctxT = input + cacheRead + cacheWrite). */
function runTurnEnd(
	{ handlers }: Pick<MockApi, "handlers">,
	ctxT: number,
): void {
	invokeHandler(handlers, "turn_end", {
		type: "turn_end",
		turnIndex: 0,
		message: {
			role: "assistant",
			content: [],
			usage: {
				input: Math.floor(ctxT / 2),
				output: 10,
				cacheRead: ctxT - Math.floor(ctxT / 2),
				cacheWrite: 0,
			},
		},
		toolResults: [],
	});
}

describe("replace_tool_result — empty replacement stores the useless-result placeholder", () => {
	it("stores the placeholder in place: plain header, substituted details, in-place swap, no receipt", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);
		emitLong({ handlers }, "x");

		const result = await replace({ tools }, "call_A", [{ toolCallId: "x", replacement: "" }]);

		const placeholder = "tool result was not useful";
		// Plain header (no receipt was minted — pointer mode shows it only
		// when one was), N counts the stored item.
		expect(result.content[0].text).toBe(
			`Stored 1 replacement. Originals will be swapped in subsequent LLM calls:\n` +
				`  - x: ${estimateTokens(placeholder)} tokens (was 5776), ` +
				`empty replacement stored as "${placeholder}"`,
		);
		// details: substituted, no receipt minted for a placeholder-only call.
		const results = result.details.results as Array<Record<string, unknown>>;
		expect(results[0].substituted).toBe(true);
		expect(results[0].ok).toBe(true);
		expect(results[0].originalTokens).toBe(5776);
		expect(results[0].replacementTokens).toBe(estimateTokens(placeholder));
		expect(results[0].grew).toBe(false);
		expect(result.details.receiptId).toBeUndefined();
		expect(result.details.replaceCallId).toBeUndefined();
		expect(result.details.mode).toBe("pointer");

		// The context swap is the in-place copy form (placeholder + marker),
		// never a pointer: the entry was not stamped.
		const ctx = runContext({ handlers }, ["x"]);
		expect(ctx.messages[0].content).toHaveLength(2);
		expect(ctx.messages[0].content[0].text).toBe(placeholder);
		expect(ctx.messages[0].content[1].text).toBe("[tool-result-replaced: toolCallId=x]");
	});

	it("treats a whitespace-only replacement the same as an empty one", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);
		emitLong({ handlers }, "x");

		const result = await replace({ tools }, "call_A", [{ toolCallId: "x", replacement: " \n\t " }]);
		const results = result.details.results as Array<Record<string, unknown>>;
		expect(results[0].substituted).toBe(true);
		expect(result.content[0].text).toContain('empty replacement stored as "tool result was not useful"');
	});

	it("does not substitute a replacement that has non-whitespace content", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);
		emitLong({ handlers }, "x");

		const result = await replace({ tools }, "call_A", [{ toolCallId: "x", replacement: "  ok  " }]);
		const results = result.details.results as Array<Record<string, unknown>>;
		expect(results[0].substituted).toBeUndefined();
		expect(results[0].replacementTokens).toBe(estimateTokens("  ok  "));
	});
});

describe("replace_tool_result — mixed calls", () => {
	it("one receipt minted, stamped for the non-empty item only (worked example 2)", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);
		emitLong({ handlers }, "x");
		emitLong({ handlers }, "z");

		const result = await replace({ tools }, "call_A", [
			{ toolCallId: "x", replacement: "" },
			{ toolCallId: "z", replacement: "ok" },
		]);

		const receiptId = result.details.receiptId as string;
		expect(receiptId).toMatch(/^rp[a-z0-9]{3}-1$/);
		expect(result.details.replaceCallId).toBe("call_A");
		// The receipt header; N counts ALL stored items (placeholder included).
		expect(result.content[0].text).toContain(
			`Receipt ${receiptId}: stored 2 replacements (call call_A). ` +
				"Originals are swapped for a pointer to this call's arguments in subsequent LLM calls:",
		);
		expect(result.content[0].text).toContain(
			`  - x: ${estimateTokens("tool result was not useful")} tokens (was 5776), ` +
				`empty replacement stored as "tool result was not useful"`,
		);
		expect(result.content[0].text).toContain(
			`  - z: ${estimateTokens("ok")} tokens (was ${estimateTokens(LONG)})`,
		);
		const results = result.details.results as Array<Record<string, unknown>>;
		expect(results[0].substituted).toBe(true);
		expect(results[1].substituted).toBeUndefined();

		// The swap: x in place (placeholder + marker), z a pointer naming
		// this call and receipt.
		const ctx = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_A", name: "replace_tool_result", arguments: {} }],
				},
				{ role: "toolResult", toolCallId: "x", toolName: "bash", content: [{ type: "text", text: "o" }], isError: false },
				{ role: "toolResult", toolCallId: "z", toolName: "bash", content: [{ type: "text", text: "o" }], isError: false },
			],
		}) as { messages: Array<{ content: Array<{ type: string; text: string }> }> };
		expect(ctx.messages[1].content).toHaveLength(2);
		expect(ctx.messages[1].content[0].text).toBe("tool result was not useful");
		expect(ctx.messages[1].content[1].text).toBe("[tool-result-replaced: toolCallId=x]");
		expect(ctx.messages[2].content).toHaveLength(1);
		expect(ctx.messages[2].content[0].text).toBe(
			`[tool-result-replaced: toolCallId=z; summary is the replacement text for this id in your replace_tool_result call call_A, receipt ${receiptId}]`,
		);
	});

	it("a placeholder-only call mints no receipt and leaves the counter untouched (worked example 3)", async () => {
		vi.stubEnv("TOOLCLIP_RECEIPT_TAG_LENGTH", "0"); // deterministic ids
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);
		emitLong({ handlers }, "z");
		emitLong({ handlers }, "x");
		emitLong({ handlers }, "w");

		const first = await replace({ tools }, "call_1", [{ toolCallId: "z", replacement: "ok" }]);
		expect(first.details.receiptId).toBe("rp-1");

		const empty = await replace({ tools }, "call_2", [{ toolCallId: "x", replacement: "" }]);
		expect(empty.details.receiptId).toBeUndefined();
		expect(empty.details.replaceCallId).toBeUndefined();
		expect(empty.content[0].text).toBe(
			`Stored 1 replacement. Originals will be swapped in subsequent LLM calls:\n` +
				`  - x: ${estimateTokens("tool result was not useful")} tokens (was 5776), ` +
				`empty replacement stored as "tool result was not useful"`,
		);

		// The counter was NOT consumed: the next real receipt keeps its number.
		const third = await replace({ tools }, "call_3", [{ toolCallId: "w", replacement: "ok" }]);
		expect(third.details.receiptId).toBe("rp-2");
	});
});

describe("replace_tool_result — re-replacement with an empty replacement", () => {
	it("clears the stamps, so the swap falls back to the in-place form (worked example 4)", async () => {
		vi.stubEnv("TOOLCLIP_RECEIPT_TAG_LENGTH", "0");
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);
		emitLong({ handlers }, "z");

		await replace({ tools }, "call_1", [{ toolCallId: "z", replacement: "ok" }]);
		const second = await replace({ tools }, "call_2", [{ toolCallId: "z", replacement: "" }]);

		// Plain header, substituted line, no new receipt.
		expect(second.details.receiptId).toBeUndefined();
		expect(second.content[0].text).toBe(
			`Stored 1 replacement. Originals will be swapped in subsequent LLM calls:\n` +
				`  - z: ${estimateTokens("tool result was not useful")} tokens (was 5776), ` +
				`empty replacement stored as "tool result was not useful"`,
		);

		// Even with call_1 present in the messages, z is swapped IN PLACE —
		// the pointer would name a call whose args no longer carry the
		// current (placeholder) replacement.
		const ctx = invokeHandler(handlers, "context", {
			type: "context",
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "replace_tool_result", arguments: {} }],
				},
				{ role: "toolResult", toolCallId: "z", toolName: "bash", content: [{ type: "text", text: "o" }], isError: false },
			],
		}) as { messages: Array<{ content: Array<{ type: string; text: string }> }> };
		expect(ctx.messages[1].content).toHaveLength(2);
		expect(ctx.messages[1].content[0].text).toBe("tool result was not useful");
		expect(ctx.messages[1].content[1].text).toBe("[tool-result-replaced: toolCallId=z]");
	});
});

describe("expiry interaction", () => {
	it("an expired id is silently ignored even with an empty replacement (worked example 5)", async () => {
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);
		// x expires (S_i crosses its pay-back threshold); z is big enough to
		// survive the same boundary.
		emitLong({ handlers }, "x");
		emitLong({ handlers }, "z", HUGE);
		runContext({ handlers }, ["x", "z"]);
		// Turn 1: both counted (ctxSeen = 6000).
		runTurnEnd({ handlers }, 6000);
		// Turn 2: S_i = 14000. x: net = 5776 - 170 - 95 = 5511, threshold
		// 0.25 * 5511 * 10 = 13777.5 → expired. z: net ≈ 8342 → threshold ≈
		// 20855 → survives.
		runTurnEnd({ handlers }, 20000);

		const result = await replace({ tools }, "call_A", [
			{ toolCallId: "x", replacement: "" },
			{ toolCallId: "z", replacement: "ok" },
		]);

		const results = result.details.results as Array<Record<string, unknown>>;
		// x: silently ignored — never an error, never substituted.
		expect(results[0]).toEqual({ toolCallId: "x", ok: true, ignored: "expired" });
		// z stored normally: one receipt, stamped.
		expect(result.details.receiptId).toMatch(/-1$/);
		expect(results[1].substituted).toBeUndefined();
		// The text lists only stored items — expired ids in neither line.
		expect(result.content[0].text).toContain("stored 1 replacement (call call_A)");
		expect(result.content[0].text).toContain(
			`  - z: ${estimateTokens("ok")} tokens (was ${estimateTokens(HUGE)})`,
		);
		expect(result.content[0].text).not.toContain("- x");
	});

	it("a substituted store resets the pile: the id leaves the nag (worked example 1)", async () => {
		const { handlers, pi, tools, steers } = createMockApi();
		toolclip(pi as never);
		emitLong({ handlers }, "x");
		runContext({ handlers }, ["x"]);
		// Counted at this boundary; pileTotal 5776 crossed the first rung.
		runTurnEnd({ handlers }, 6000);
		expect(steers).toHaveLength(1);
		expect((steers[0].content as string)).toContain("- x (~5776 tokens)");

		await replace({ tools }, "call_A", [{ toolCallId: "x", replacement: "" }]);
		// The substituted store reset the pile to 0: the level re-arms, no nag.
		runTurnEnd({ handlers }, 7000);
		expect(steers).toHaveLength(1);

		// A fresh pile re-fires — listing the new id, not the substituted one.
		emitLong({ handlers }, "y");
		runContext({ handlers }, ["y"]);
		runTurnEnd({ handlers }, 8000);
		expect(steers).toHaveLength(2);
		const text = steers[1].content as string;
		expect(text).toContain("- y (~5776 tokens)");
		expect(text).not.toContain("- x ");
	});
});

describe("config — custom placeholder text", () => {
	it("stores and echoes the configured TOOLCLIP_EMPTY_REPLACEMENT_TEXT", async () => {
		vi.stubEnv("TOOLCLIP_EMPTY_REPLACEMENT_TEXT", "checked: nothing found");
		const { handlers, pi, tools } = createMockApi();
		toolclip(pi as never);
		emitLong({ handlers }, "x");

		const result = await replace({ tools }, "call_A", [{ toolCallId: "x", replacement: "" }]);
		expect(result.content[0].text).toContain(
			`empty replacement stored as "checked: nothing found"`,
		);
		const results = result.details.results as Array<Record<string, unknown>>;
		expect(results[0].replacementTokens).toBe(estimateTokens("checked: nothing found"));

		const ctx = runContext({ handlers }, ["x"]);
		expect(ctx.messages[0].content[0].text).toBe("checked: nothing found");
	});
});

describe("runtime-state housekeeping — pendingIds checks against undefined", () => {
	it("an entry whose stored placeholder is an empty string is replaced, not pending", () => {
		const state = createRuntimeState();
		recordPending(state, "x", 500, "content");
		recordReplacement(state, "x", "", 0); // placeholder configured as ""
		expect(pendingIds(state)).toEqual([]);
		expect(replacedIds(state)).toEqual(["x"]);
	});
});