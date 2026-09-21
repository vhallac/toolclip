/**
 * Extension-level tests for the quarantine flow.
 *
 * Drives the mock pi event bus through the "held until read; freed after
 * reading" contract:
 *   1. A tool result above the quarantine threshold (10000 tokens) is
 *      withheld: content swapped for a notice, payload held, no pending
 *      entry (there is nothing in context to replace).
 *   2. A read is honored at any later turn — there is no one-turn window
 *      and no eviction; the read's own result re-enters the normal
 *      pending-marker path (replaceable, never re-quarantined).
 *   3. After a read releases the payload, later reads for the id are
 *      denied as "already read"; reads for never-quarantined ids are
 *      denied as "never held" (pointing at the pending-marker path).
 *   4. Held payloads survive round boundaries.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import toolclip from "../src/toolclip.ts";
import { createMockApi, invokeHandler, invokeTool } from "./_helpers/mock-pi.ts";
import { estimateTokens } from "../lib/tokens.ts";

// 64,276 tokens estimated (tokenx 14286 + 49990 space-free counterweight) —
// strictly above the 10000 quarantine threshold.
const QUAR_TEXT = "x".repeat(100000);
// 5776 tokens estimated (tokenx 1286 + 4490 space-free counterweight) —
// below quarantine, above the 1000 pending threshold.
const PEND_TEXT = "y".repeat(9000);
// tokenx: 10000 tokens — exactly at the quarantine threshold (not above).
// Estimated at well above the default threshold by the counterweight, so the
// boundary test pins the threshold to the fixture's own estimate.
const BOUNDARY_TEXT = "z".repeat(70000);

function toolResultEvent(toolCallId: string, text: string, toolName = "bash") {
	return {
		type: "tool_result",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("toolclip quarantine — tool_result handling", () => {
	it("withholds a result above the quarantine threshold: notice swapped in, payload not in context", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });

		const result = invokeHandler(handlers, "tool_result", toolResultEvent("bash-1", QUAR_TEXT)) as {
			content: Array<{ type: string; text: string }>;
		};

		expect(result.content).toHaveLength(1); // content swapped, not marker-appended
		const notice = result.content[0].text;
		expect(notice).toContain("[tool-result-quarantined: toolCallId=bash-1, tokens=64276]");
		expect(notice).toContain("read_quarantined_result");
		expect(notice).not.toContain(QUAR_TEXT);
	});

	it("marks — but does not quarantine — a result between the pending and quarantine thresholds", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });

		const result = invokeHandler(handlers, "tool_result", toolResultEvent("bash-1", PEND_TEXT)) as {
			content: Array<{ type: string; text: string }>;
		};

		expect(result.content).toHaveLength(2);
		expect(result.content[0].text).toBe(PEND_TEXT); // original intact
		expect(result.content[1].text).toBe(
			"[tool-result-pending-replacement: toolCallId=bash-1, tokens=5776]",
		);
	});

	it("treats a result exactly at the quarantine threshold as pending, not quarantined", () => {
		const { handlers, pi } = createMockApi();
		// The strictness contract is `tokens > threshold` quarantines: a result
		// at exactly the threshold must stay a pending marker. Pin the
		// threshold to the fixture's own estimate so the boundary holds
		// regardless of the estimator's absolute numbers.
		vi.stubEnv(
			"TOOLCLIP_QUARANTINE_THRESHOLD_TOKENS",
			String(estimateTokens(BOUNDARY_TEXT)),
		);
		toolclip(pi as never);
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });

		const result = invokeHandler(handlers, "tool_result", toolResultEvent("bash-1", BOUNDARY_TEXT)) as {
			content: Array<{ type: string; text: string }>;
		};

		expect(result.content).toHaveLength(2);
		expect(result.content[1].text).toContain("tool-result-pending-replacement");
	});
});

describe("toolclip quarantine — read/release cycle (session-lifetime hold)", () => {
	it("honors an immediate read in the turn after the quarantine, even alongside other tool calls", async () => {
		const { handlers, tools, pi } = createMockApi();
		toolclip(pi as never);
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
		invokeHandler(handlers, "tool_result", toolResultEvent("bash-1", QUAR_TEXT));

		// Turn 1: the LLM issues the read (as one of several tool calls).
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
		const read = (await invokeTool(tools, "read_quarantined_result", "read-1", {
			toolCallId: "bash-1",
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

		expect(read.details).toMatchObject({ ok: true, toolCallId: "bash-1", tokens: 64276 });
		expect(read.content[0].text).toBe(QUAR_TEXT); // full payload returned

		// pi fires tool_result for the read itself: the payload is marked
		// replaceable — and NOT re-quarantined.
		const readResult = invokeHandler(
			handlers,
			"tool_result",
			toolResultEvent("read-1", QUAR_TEXT, "read_quarantined_result"),
		) as { content: Array<{ type: string; text: string }> };
		expect(readResult.content).toHaveLength(2);
		expect(readResult.content[0].text).toBe(QUAR_TEXT);
		expect(readResult.content[1].text).toBe(
			"[tool-result-pending-replacement: toolCallId=read-1, tokens=64276]",
		);

		// The read result is replaceable via the normal mechanism.
		const replace = (await invokeTool(tools, "replace_tool_result", "llm-replace-1", {
			items: [{ toolCallId: "read-1", replacement: "key facts from the payload" }],
		})) as { details: Record<string, unknown> };
		expect(replace.details).toMatchObject({ ok: true });

		// turn_end of turn 1: nothing is evicted — the payload was already
		// released by the read.
		invokeHandler(handlers, "turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
		// A late second read for the original id is denied as already-read.
		const late = (await invokeTool(tools, "read_quarantined_result", "read-2", {
			toolCallId: "bash-1",
		})) as { details: Record<string, unknown>; content: Array<{ type: string; text: string }> };
		expect(late.details).toMatchObject({ ok: false, reason: "already-read" });
		expect(late.content[0].text).toContain("already read");
	});

	it("honors a read many turns later — no eviction at turn boundaries", async () => {
		const { handlers, tools, pi } = createMockApi();
		toolclip(pi as never);
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
		invokeHandler(handlers, "tool_result", toolResultEvent("bash-1", QUAR_TEXT));

		// Turn 1 passes without a read: turn boundaries hold nothing back and
		// evict nothing.
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
		invokeHandler(handlers, "turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});

		// Turn 2: the model finally wants the full payload — still held.
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 2, timestamp: 2 });
		const late = (await invokeTool(tools, "read_quarantined_result", "read-1", {
			toolCallId: "bash-1",
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

		expect(late.details).toMatchObject({ ok: true, toolCallId: "bash-1", tokens: 64276 });
		expect(late.content[0].text).toBe(QUAR_TEXT);
	});

	it("a read in the same turn the quarantine was created is impossible — but a same-turn-end batch still honors the read issued in the next turn", async () => {
		const { handlers, tools, pi } = createMockApi();
		toolclip(pi as never);
		// Turn 0: LLM emits multiple tool calls; one result is huge and gets
		// quarantined. All results land in the same turn_end batch.
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
		invokeHandler(handlers, "tool_result", toolResultEvent("bash-1", QUAR_TEXT));
		invokeHandler(handlers, "tool_result", toolResultEvent("grep-1", "small result"));
		invokeHandler(handlers, "turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});

		// The turn_end that delivered the notice must NOT have freed it.
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
		const read = (await invokeTool(tools, "read_quarantined_result", "read-1", {
			toolCallId: "bash-1",
		})) as { details: Record<string, unknown> };
		expect(read.details).toMatchObject({ ok: true, toolCallId: "bash-1" });
	});

	it("a quarantined id is not replaceable — nothing of it is in context", async () => {
		const { handlers, tools, pi } = createMockApi();
		toolclip(pi as never);
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
		invokeHandler(handlers, "tool_result", toolResultEvent("bash-1", QUAR_TEXT));

		const replace = (await invokeTool(tools, "replace_tool_result", "llm-replace-1", {
			items: [{ toolCallId: "bash-1", replacement: "should not work" }],
		})) as { details: { results: Array<{ ok: boolean; reason?: string }> } };
		expect(replace.details.results[0]).toMatchObject({ ok: false, reason: "unknown id" });
	});

	it("held payloads survive a round boundary (read honored after before_agent_start)", async () => {
		const { handlers, tools, pi } = createMockApi();
		toolclip(pi as never);
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
		invokeHandler(handlers, "tool_result", toolResultEvent("bash-1", QUAR_TEXT));

		// A new round starts (before_agent_start) — e.g. the previous run was
		// aborted. Held payloads are NOT cleared: they are held for the
		// session's lifetime, and the read is still honored.
		invokeHandler(handlers, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			messages: [],
		});
		const read = (await invokeTool(tools, "read_quarantined_result", "read-1", {
			toolCallId: "bash-1",
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
		expect(read.details).toMatchObject({ ok: true, toolCallId: "bash-1", tokens: 64276 });
		expect(read.content[0].text).toBe(QUAR_TEXT);
	});

	it("a read for a pending-marked (never quarantined) id is denied as never-held, pointing at distillation", async () => {
		const { handlers, tools, pi } = createMockApi();
		toolclip(pi as never);
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });

		// A pending-marked result — the observed confusion: the model mistakes
		// the pending marker for a quarantine notice and tries to "read" it.
		invokeHandler(handlers, "tool_result", toolResultEvent("bash-1", PEND_TEXT));
		const read = (await invokeTool(tools, "read_quarantined_result", "read-1", {
			toolCallId: "bash-1",
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

		expect(read.details).toMatchObject({ ok: false, reason: "never-held" });
		expect(read.content[0].text).toContain("[quarantine-missed: toolCallId=bash-1]");
		expect(read.content[0].text).toContain("never quarantined");
		expect(read.content[0].text).toContain("distill it with replace_tool_result");
		expect(read.content[0].text).not.toContain(PEND_TEXT);
	});
});

describe("toolclip quarantine — system prompt", () => {
	it("injects the quarantine instructions with the configured threshold", () => {
		const { handlers, pi } = createMockApi();
		toolclip(pi as never);
		const result = invokeHandler(handlers, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base prompt",
			messages: [],
		}) as { systemPrompt: string };

		expect(result.systemPrompt.startsWith("base prompt")).toBe(true);
		expect(result.systemPrompt).toContain("## Quarantined Tool Results");
		expect(result.systemPrompt).toContain("above 10000 tokens");
		expect(result.systemPrompt).toContain("read_quarantined_result");
		expect(result.systemPrompt).toContain("narrower scope");
		// Anti-piecemeal directive: read the whole payload from the quarantine
		// instead of reconstructing it with partial fetches.
		expect(result.systemPrompt).toContain("read it from the quarantine — do NOT reconstruct it");
		expect(result.systemPrompt).toContain("offset/limit chunks");
		// Hold-until-read semantics, stated neutrally (no deadline — the
		// former urgency collided with the steering nag).
		expect(result.systemPrompt).toContain("held until you read it");
		expect(result.systemPrompt).not.toContain("immediately next response");
		expect(result.systemPrompt).not.toContain("held for exactly one");
	});
});

describe("toolclip quarantine — disabled via TOOLCLIP_QUARANTINE=false", () => {
	it("falls back to the plain pending-marker path for oversized results", () => {
		vi.stubEnv("TOOLCLIP_QUARANTINE", "false");
		const { handlers, tools, pi } = createMockApi();
		toolclip(pi as never);
		invokeHandler(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });

		const result = invokeHandler(handlers, "tool_result", toolResultEvent("bash-1", QUAR_TEXT)) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(result.content).toHaveLength(2);
		expect(result.content[0].text).toBe(QUAR_TEXT);
		expect(result.content[1].text).toContain("tool-result-pending-replacement");
	});
});