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
- Injects a **steering reminder** through **pi's native steering** (`sendUserMessage(..., {deliverAs: "steer"})` from the `turn_end` handler) when either steering trigger fires — the count of un-replaced pending results strictly exceeds `TOOLCLIP_STEERING_COUNT_THRESHOLD` (default 5), or their total estimated tokens strictly exceed `TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS` (default 5000). The message summarizes the pile ("you have N tool-result-pending-replacements totalling ~T estimated tokens") and lists the pending ids with their sizes — surfacing a single huge hog at a glance. Each trigger nags **once per excursion** (its latch re-arms when its condition falls back to the threshold or below), and the latches are independent: a count fire never suppresses a later size crossing, which is what catches a single huge un-replaced result (count = 1) — the blindspot of the earlier count-band design. The steer is **persisted as a real user message** at the next turn boundary: part of the session's message list, visible in every subsequent LLM call, included in compaction/summarization — this replaces the earlier synthetic context append, which was consumed for a single LLM call and never written to the session (the post-fix golden run of 2026-09-20 showed the model seeing each nag exactly once while the pile stayed above both thresholds for 119 consecutive calls). Observation happens at `turn_end` (after the turn's tool results are in — freshest pile state at the boundary; pi polls the steering queue immediately after, so the nag is visible from the very next LLM call). Latches reset at each round boundary in `before_agent_start`, so a pile persisting into a new round is re-announced at that round's first turn boundary.
- **Quarantines** results strictly above `quarantineThresholdTokens` (default 10000) at `tool_result` time: content swapped for a `[tool-result-quarantined: toolCallId=id, tokens=N]` notice, payload held in the quarantine store. Registers `read_quarantined_result(toolCallId)` — the escape hatch. The LLM first sees the notice in the turn after the quarantine (pi delivers a turn's tool results at that turn's `turn_end`, so the LLM cannot react within the creating turn), but there is no read window: payloads are held for the session's lifetime ("held until read; freed after reading") and a read is honored at any later turn, even among several tool calls in the batch. A read releases the payload — later reads for the id are denied with `[quarantine-missed: toolCallId=id]` and an `already-read` reason; a read for a never-quarantined id (typically a pending-marked result misread as a quarantine notice) is denied with a `never-held` reason that points at the pending-marker distillation path. No eviction anywhere: the session file holds only the notice, so the in-memory payload is the only copy — the former one-turn window was permanent data destruction and collided with the steering nag (2026-09-20 golden run). The read's own result flows down the normal pending-marker path (replaceable, never re-quarantined). Held payloads survive round boundaries (`before_agent_start` does not clear them).
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
| `TOOLCLIP_STEERING_REMINDER` | `true` | Whether to deliver steering reminders when marked results stay un-replaced (count or size trigger). |
| `TOOLCLIP_STEERING_COUNT_THRESHOLD` | `5` | Count trigger: the reminder fires when the pending count strictly exceeds this, and re-arms when it falls back to the threshold or below (one nag per excursion). |
| `TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS` | `5000` | Size trigger: the reminder also fires when the pile's total estimated tokens strictly exceed this (same re-arm rule). Independent latch — catches a single huge un-replaced result, which the count trigger is blind to. |
| `TOOLCLIP_QUARANTINE` | `true` | Whether oversized results are quarantined (payload held until read, retrievable via `read_quarantined_result`). Disable to fall back to plain pending markers for all sizes. |
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
- The steering reminder is delivered via pi's native steering (`sendUserMessage(..., {deliverAs: "steer"})` from the `turn_end` handler): observed when either trigger is strictly above its threshold (count > 5, or total estimated tokens > 5000), once per excursion with independent latches. It must stay **persisted** (a real user message in the session, visible on every later call) — never move it back to a synthetic append in the `context` handler: that array is consumed for exactly one provider call and never written to the session, so the nag flashes once and vanishes. Latches reset at each round boundary (`before_agent_start`).
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
