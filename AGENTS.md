# toolclip

Targeted context reduction for individual tool results in pi coding agent sessions.

This project is a standalone pi extension: when a tool returns a long result, it appends a marker the LLM can act on, and the LLM may call `replace_tool_result(id, replacement)` to swap that bulky result for a tight replacement in subsequent turns. The LLM is the only actor. There is no auto-summarizer and no auto-eviction.

## Why this is separate from sesclip

Sesclip compacts the **entire** session context when it crosses a threshold. Toolclip is targeted — it touches **individual tool results**, and only when the LLM chooses. Different thresholds, different prompts, different mechanics. Combining them would muddle two distinct products.

## The Extension

The extension lives at `src/toolclip.ts` and follows the Semblr split: a thin pi extension entrypoint in `src/`, reusable logic in `lib/`. It:

- Listens to the `tool_result` event; appends a `[tool-result-pending-replacement: toolCallId=id, tokens=N]` marker to the LLM-facing content of every non-empty text result (the original stays intact). Size thresholds were removed so replacement behavior can be observed without pre-filtering.
- Registers a `replace_tool_result(toolCallId, replacement)` tool the LLM can call at its leisure. **No length gate is applied** — replacements of any size are accepted, and the tool records a `grew` flag (`replacementTokens >= originalTokens`) in its details as the observation target for reintroducing a gate later.
- Listens to the `context` event; before each LLM call, swaps any `ToolResultMessage` whose `toolCallId` has a stored replacement to `[replacement]\n[tool-result-replaced: toolCallId=id]`. This is the cache-break point — known and accepted.
- Injects a **steering reminder**: a single trailing `user` message, at most once per round, when the agent has left marked results un-replaced for several turns. It is appended to the *end* of the context (pi's standard steering path), so the cached prefix is never touched. Reset at each round boundary in `before_agent_start`.
- Injects system-prompt instructions explaining the marker and the tool. If the LLM never calls the tool, the original result stays.

## Target Project Structure

- `README.md` — overview, limits, usage, behavior
- `AGENTS.md` — this file
- `src/toolclip.ts` — thin extension entrypoint
- `lib/` — config, token estimator, marker, runtime state, steering, shared types
- `tests/` — unit and integration tests
- `eval/` — golden-spec runners and runs (mirrors sesclip)
- `doc/` — design notes, prompt contracts, architecture
- `temp/` — transient plans and notes
- `index.ts` — re-export of `src/toolclip.ts`

## Configuration

No size-bound configuration is applied at present. Size thresholds (the marker token threshold and the max-replacement-ratio) were removed so replacement behavior can be observed without pre-filtering or gating — the bet being that we should confirm replacements actually bloat context before band-aiding a healthy finger. The config plumbing (`loadToolclipConfig`) and the `ToolclipConfig` interface remain so limits can be reintroduced once observation warrants.

The steering reminder is configurable:

| Env var | Default | Meaning |
|---|---|---|
| `TOOLCLIP_STEERING_REMINDER` | `true` | Whether to inject the once-per-round steering reminder when marked results stay un-replaced. |
| `TOOLCLIP_STEERING_REMINDER_TURN` | `3` | Minimum number of tool-result-bearing turns (with an un-replaced marker present) before the reminder becomes eligible. Fires at most once per round. |

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
- Size thresholds are currently removed for observation. Replacements of any size are accepted; the tool records a `grew` flag (`replacementTokens >= originalTokens`) in its details. `grew: true` in real runs is the signal to reintroduce a length gate — do not add one speculatively.
- The steering reminder fires at most once per round. It is appended to the *end* of the context as a new `user` message (pi steering path) — never modify the original prompt or prior messages. The latch resets at each round boundary (`before_agent_start`).
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
