# toolclip

Targeted context reduction for individual tool results in pi coding agent sessions.

This project is a standalone pi extension: when a tool returns a long result, it appends a marker the LLM can act on, and the LLM may call `replace_tool_result(id, replacement)` to swap that bulky result for a tight replacement in subsequent turns. The LLM is the only actor. There is no auto-summarizer and no auto-eviction.

## Why this is separate from sesclip

Sesclip compacts the **entire** session context when it crosses a threshold. Toolclip is targeted — it touches **individual tool results**, and only when the LLM chooses. Different thresholds, different prompts, different mechanics. Combining them would muddle two distinct products.

## The Extension

The extension lives at `src/toolclip.ts` and follows the Semblr split: a thin pi extension entrypoint in `src/`, reusable logic in `lib/`. It:

- Listens to the `tool_result` event; when a result exceeds the token threshold, appends a `[tool-result-pending-replacement: toolCallId=id, tokens=N]` marker to the LLM-facing content (the original stays intact).
- Registers a `replace_tool_result(toolCallId, replacement)` tool the LLM can call at its leisure. The call is gated by a hard-fail / soft-fail length check (replacement must be strictly shorter than the original, and within `maxReplacementRatio × original`).
- Listens to the `context` event; before each LLM call, swaps any `ToolResultMessage` whose `toolCallId` has a stored replacement to `[replacement]\n[tool-result-replaced: toolCallId=id]`. This is the cache-break point — known and accepted.
- Injects system-prompt instructions explaining the marker and the tool. If the LLM never calls the tool, the original result stays.

## Target Project Structure

- `README.md` — overview, limits, usage, behavior
- `AGENTS.md` — this file
- `src/toolclip.ts` — thin extension entrypoint
- `lib/` — config, token estimator, marker, runtime state, length gate, shared types
- `tests/` — unit and integration tests
- `eval/` — golden-spec runners and runs (mirrors sesclip)
- `doc/` — design notes, prompt contracts, architecture
- `temp/` — transient plans and notes
- `index.ts` — re-export of `src/toolclip.ts`

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS` | `250` | Tool results above this estimated token count get the pending marker appended. |
| `TOOLCLIP_MAX_REPLACEMENT_RATIO` | `0.1` | Soft-fail ceiling. Replacement must be at most `ratio × original` tokens. Hard-fail ceiling is `1.0` (replacement must be strictly shorter than original). |

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
- The length gate is strict: hard fail (replacement ≥ original) AND soft fail (replacement > ratio × original).
- The marker is appended, not destructive.
- After swap, the replaced content keeps a `[tool-result-replaced: id]` marker for traceability.
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
