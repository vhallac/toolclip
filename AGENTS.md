# toolclip

Targeted context reduction for individual tool results in pi coding agent sessions.

This project is a standalone pi extension: when a tool returns a long result, it appends a marker the LLM can act on, and the LLM may call `replace_tool_result(id, replacement)` to swap that bulky result for a tight replacement in subsequent turns. The LLM is the only actor. There is no auto-summarizer and no auto-eviction.

## Why this is separate from sesclip

Sesclip compacts the **entire** session context when it crosses a threshold. Toolclip is targeted — it touches **individual tool results**, and only when the LLM chooses. Different thresholds, different prompts, different mechanics. Combining them would muddle two distinct products.

## The Extension

The extension lives at `src/toolclip.ts` and follows the Semblr split: a thin pi extension entrypoint in `src/`, reusable logic in `lib/`. It:

- Listens to the `tool_result` event; appends a `[tool-result-pending-replacement: toolCallId=id, tokens=N]` marker to the LLM-facing content only of results strictly above the token threshold (default 1000) (the original stays intact). The max-replacement-ratio gate stays removed — replacements of any size are accepted.
- Registers a `replace_tool_result(toolCallId, replacement)` tool the LLM can call at its leisure. **No length gate is applied** — replacements of any size are accepted, and the tool records a `grew` flag (`replacementTokens >= originalTokens`) in its details as the observation target for reintroducing a gate later.
- Listens to the `context` event; before each LLM call, swaps any `ToolResultMessage` whose `toolCallId` has a stored replacement to `[replacement]\n[tool-result-replaced: toolCallId=id]`. This is the cache-break point — known and accepted.
- Injects a **steering reminder**: a trailing `user` message when the count of un-replaced pending results first reaches each multiple of `TOOLCLIP_STEERING_REMINDER_MULTIPLE` (default 5), summarizing the pile ("you have N tool-result-pending-replacements") and listing the pending ids. Re-arms when the count drops below the announced band (a re-grown pile is nagged again). Appended to the *end* of the context (pi's standard steering path), so the cached prefix is never touched. Band resets at each round boundary in `before_agent_start`, so a pile persisting into a new round is re-announced on its first LLM call.
- **Quarantines** results strictly above `quarantineThresholdTokens` (default 10000) at `tool_result` time: content swapped for a `[tool-result-quarantined: toolCallId=id, tokens=N]` notice, payload held in the quarantine store. Registers `read_quarantined_result(toolCallId)` — a single-turn escape hatch. The read window is the turn after the quarantine (pi delivers a turn's tool results at that turn's `turn_end`, so the LLM cannot react within the creating turn); reads execute during the window and are honored even among several tool calls in the batch. At the `turn_end` closing the window (`createdTurn <= turnIndex - 1`), unread payloads are evicted — later reads are denied with `[quarantine-missed: toolCallId=id]`. The read's own result flows down the normal pending-marker path (replaceable, never re-quarantined). Held payloads never survive a round boundary (`before_agent_start` clears defensively, e.g. after aborted runs).
- Injects system-prompt instructions explaining the marker and the tool. The directive gives a method — read → extract ALL relevant information (not just the next step) into the replacement → replace — and states that a replacement is irreversible: recovering a dropped detail means a fresh full tool call. Both failure modes are named: replacing half-informed (distill-refetch loop), and deferring after extraction is complete. The quarantine section and notice add the part-vs-whole rule: need the whole payload → read it from the quarantine once; never reconstruct it piecemeal with several narrowed calls. If the LLM never calls the tool, the original result stays.
- Observes same-path re-reads: successful `read` results are counted per path within the round; from the second read of a path (consecutive or not), the result's `details` carry `toolclipReread: { path, count }` — the observation target for the distill-refetch loop, alongside the `grew` flag on replacements. Diagnostic only; content and cache are untouched. Counter resets at each round boundary.

## Target Project Structure

- `README.md` — overview, limits, usage, behavior
- `AGENTS.md` — this file
- `src/toolclip.ts` — thin extension entrypoint
- `lib/` — config, token estimator, marker, runtime state, steering, quarantine, shared types
- `tests/` — unit and integration tests
- `eval/` — golden-spec runners and runs (mirrors sesclip)
- `doc/` — design notes, prompt contracts, architecture
- `temp/` — transient plans and notes
- `index.ts` — re-export of `src/toolclip.ts`

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS` | `1000` | Minimum estimated token count for a tool result to get a pending marker. Results at or below the threshold are left untouched — too small for distillation to pay off. |
| `TOOLCLIP_STEERING_REMINDER` | `true` | Whether to inject the count-based steering reminder when marked results stay un-replaced. |
| `TOOLCLIP_STEERING_REMINDER_MULTIPLE` | `5` | Band size: the reminder fires when the pending count first reaches each multiple of this value (5–9, 10–14, ...), and re-arms when the count drops back below the announced band. |
| `TOOLCLIP_QUARANTINE` | `true` | Whether oversized results are quarantined (payload held for one turn, retrievable via `read_quarantined_result`). Disable to fall back to plain pending markers for all sizes. |
| `TOOLCLIP_QUARANTINE_THRESHOLD_TOKENS` | `10000` | Minimum estimated token count for a tool result to be quarantined. Must sit well above the pending threshold. |

The max-replacement-ratio gate is intentionally **not** reintroduced: `replace_tool_result` accepts a replacement of any size and records a `grew` flag when a replacement is at least as large as its original — the observation target for reintroducing a length gate later.

Token estimation uses `Math.ceil(text.length / 4)` (chars/4 heuristic, same as sesclip).

## Development Methodology

For implementation tasks, use code-and-test-together development.

1. **Understand** — restate required behavior, identify anchors (docs, fixtures, CLI output, logs, existing behavior), surface assumptions before changing code.
2. **Plan code and tests together** — identify production changes and the tests that protect required and affected behavior. Refactor only as needed to expose test seams; preserve behavior.
3. **Implement first pass** — write production code and matching tests together. Tests MUST check externally anchored behavior, not mirror implementation. Prefer focused regression tests.
4. **Validate externally** — run the relevant tests and available verification commands. Prefer `npm run verify` when available. Passing tests alone are insufficient if the requirement was not checked against an anchor.
5. **Diagnose failures before fixing** — classify each failure (code / test / mechanical / requirement) and fix the diagnosed source. NEVER weaken tests merely to pass; changed expectations need an anchor.
6. **Harden** — add branch, edge-case, and regression tests after main behavior works.
7. **Update README.md if needed** — for changed commands, env vars, thresholds, prompt wording, restart behavior, or user-visible flow.

## Design Constraints

- Keep `src/toolclip.ts` thin; move policy and logic into `lib/`.
- The LLM is the only actor that can mark a result for replacement.
- The LLM must see the original tool result at least once before any replacement.
- The marker is appended, not destructive.
- After swap, the replaced content keeps a `[tool-result-replaced: id]` marker for traceability.
- Marker threshold re-introduced at 1000 tokens (default): results at or below the threshold get no marker. The max-replacement-ratio gate stays removed — replacements of any size are accepted; the tool records a `grew` flag (`replacementTokens >= originalTokens`) in its details. `grew: true` in real runs is the signal to reintroduce a length gate — do not add one speculatively.
- The steering reminder is count-based: it fires when the pending count first reaches each multiple of the band size (default 5) and re-arms when the count drops below the announced band. It is appended to the *end* of the context as a new `user` message (pi steering path) — never modify the original prompt or prior messages. The band resets at each round boundary (`before_agent_start`).
- The replace directive must stay two-sided: pressure to extract completely BEFORE replacing (a replacement is irreversible; a dropped detail costs a full re-read) and pressure to replace promptly AFTER extraction (an un-replaced original costs context every turn). Do not reintroduce one-sided "replace as early as possible" wording — it produced the distill-refetch loop in the 2026-09-20 pro golden run.
- The re-read counter (`readsThisRound`) is diagnostic only: it must never modify LLM-facing content or cache behavior. Its `toolclipReread` details entry (count >= 2 per path, per round) is the automated signal for the distill-refetch loop; `grew` remains the signal for replacement bloat.
- Verify with real commands before claiming completion.

## Attributions

- When committing code that is entirely written by you, add

🤖 LLM authored

- When committing code that is partially written by you (50% or less), and the rest is written by a human, add

🤖 LLM assisted

- When writing code forge pull requests, comments, issues, or contributing to discussions, add

🤖 Content created by LLM

as the last line of the text.

When only creating commit messages to code fully written by a human; do not add an LLM attribution.
