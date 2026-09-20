# toolclip

A pi coding agent extension that shrinks long tool results without losing them. When a tool returns a result above the configured token threshold (default 1000), toolclip appends a marker the LLM can act on. The LLM may then call `replace_tool_result(id, replacement)` to swap that bulky result for a tight replacement in subsequent turns.

The LLM is the only actor. There is no auto-summarizer and no auto-eviction. The cache break that happens when a result is replaced is known and accepted — the bet is that a 15-line replacement wins over the duration of a long session against a 10K tool result.

## Status

🚧 Bootstrap complete. Implementation per `.todo/task_plan.md` (12 units, cautious mode).

## What it does

1. On the `tool_result` event, append a marker to the LLM-facing content of every non-empty text tool result:
   ```
   [tool-result-pending-replacement: toolCallId=abc, tokens=1024]
   ```
   The original content is **not** modified. Only results strictly above the token threshold (default 1000) are marked — smaller results are too cheap to distill.
2. The LLM can call `replace_tool_result(toolCallId, replacement)` at its leisure. **No length gate is applied** — replacements of any size are accepted. The tool records a `grew` flag (`replacementTokens >= originalTokens`) in its details so observers can detect replacements that bloat rather than shrink context. That flag is the signal for reintroducing a length gate later.
3. On the `context` event (before each LLM call), any `ToolResultMessage` whose `toolCallId` has a stored replacement is swapped to:
   ```
   <replacement>
   [tool-result-replaced: toolCallId=abc]
   ```
   The marker stays for traceability. Cache breaks here — by design.
4. If the LLM never calls the tool, the original result stays in place. No automatic eviction.
5. **Steering reminder.** If the agent leaves marked results un-replaced for several turns, toolclip injects a single trailing `user` message reminding it to call `replace_tool_result`. This fires **at most once per round**. It is cache-safe: it is appended to the *end* of the context as a new user block (pi's standard steering path), so the cached prefix — original prompt and all prior messages — is never touched; only the tail re-prepills.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS` | `1000` | Minimum estimated token count for a tool result to get a pending marker. Results at or below the threshold are left untouched. |
| `TOOLCLIP_STEERING_REMINDER` | `true` | Inject a single trailing steering reminder per round when marked results stay un-replaced for several turns. |
| `TOOLCLIP_STEERING_REMINDER_TURN` | `3` | Minimum tool-result-bearing turns while a pending marker exists before the reminder is eligible. |

The max-replacement-ratio gate is intentionally **not** reintroduced: `replace_tool_result` accepts a replacement of any size and records a `grew` flag when a replacement is at least as large as its original — the observation target for reintroducing a length gate later. Token estimation uses `Math.ceil(text.length / 4)` (chars/4 heuristic, same as sesclip).

The steering reminder is configurable:

| Env var | Default | Meaning |
|---|---|---|
| `TOOLCLIP_STEERING_REMINDER` | `true` | Whether to inject the once-per-round steering reminder when marked results stay un-replaced. |
| `TOOLCLIP_STEERING_REMINDER_TURN` | `3` | Minimum number of tool-result-bearing turns (with an un-replaced marker present) before the reminder becomes eligible. The reminder fires at most once per round. |

Token estimation uses `Math.ceil(text.length / 4)` (chars/4 heuristic).

## Why this is separate from sesclip

Sesclip compacts the **entire** session context when it crosses a threshold. Toolclip is targeted — it touches **individual tool results**, and only when the LLM chooses. Different thresholds, different prompts, different mechanics. Combining them would muddle two distinct products.

## Out of scope (deferred)

- Retrieval tools (`get_tool_result`, `grep_tool_result`, pagination).
- Real tokenizer dependency (chars/4 is good enough for token estimates).
- Auto-summarization at `tool_result` time (would lose fidelity — the LLM must see the original first).
- Size gates on replacements (removed for observation; reintroduce once we see `grew: true` in real runs).

## Develop

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run verify       # typecheck + test
```

Plan lives at `.todo/task_plan.md`. Findings at `.todo/findings.md`. Progress at `.todo/progress.md`.
