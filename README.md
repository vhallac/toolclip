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

   The injected directive gives the model a method, not just an urge: read once → extract **all** the information you may still need for the rest of the task (not just the next step) into the replacement → replace. A replacement is **irreversible** — the original is swapped out for good, and anything the model failed to capture requires a fresh full tool call. Early wording ("the earlier you replace, the more context you save") pushed a compliant model into a distill-refetch loop: replace minimal → lose detail → re-read the same file at full price. The wording now names both expensive mistakes: replacing half-informed, and deferring after extraction is complete.
3. On the `context` event (before each LLM call), any `ToolResultMessage` whose `toolCallId` has a stored replacement is swapped to:
   ```
   <replacement>
   [tool-result-replaced: toolCallId=abc]
   ```
   The marker stays for traceability. Cache breaks here — by design.
4. If the LLM never calls the tool, the original result stays in place. No automatic eviction.
5. **Steering reminder.** If the agent leaves marked results un-replaced, toolclip watches the pending count (on the `context` event, before each LLM call) and injects a trailing `user` message when the count first reaches each multiple of the band size (default 5: 5–9, 10–14, 15–19, ...). The reminder summarizes the pile — "you have N tool-result-pending-replacements" — and lists the pending ids so the agent can act on them in one batched call. When the count drops below the announced band (the agent replaced results), the band follows down silently, so a re-grown pile is nagged again. The band resets at each round boundary, so a pile persisting into a new round is re-announced on its first LLM call. Cache-safe: appended to the *end* of the context as a new user block (pi's standard steering path), so the cached prefix is never touched; only the tail re-prepills.
6. **Quarantine.** Results above a much higher threshold (default 10000 tokens) are withheld from the LLM entirely: the content is swapped for a notice
   ```
   [tool-result-quarantined: toolCallId=abc, tokens=12000]
   ```
   and the payload is held aside for exactly one turn — use it or lose it. The agent first sees the notice in the turn after the quarantine (pi delivers a turn's tool results at that turn's end, so it cannot react within the same turn); a `read_quarantined_result({ toolCallId })` call issued in that next turn is honored — even as one of several tool calls in the batch. At the turn_end that closes the window, unread payloads are freed and later read attempts are denied with a `[quarantine-missed: ...]` notice. The read's own result re-enters the normal pending-marker path (it is replaceable), and is never re-quarantined. Held payloads never survive a round boundary.

   Both the notice and the system-prompt section frame the choice as part-vs-whole: need only part of the data → re-issue a narrower call; need the whole payload → read it from the quarantine **once**. Reconstructing the payload piecemeal (offset/limit chunks, repeated narrowed calls) costs more calls and more tokens than one full read and is explicitly forbidden.
7. **Re-read observation.** Successful `read` results are counted per path within the round. From the second read of the same path — consecutive or not — the result's `details` carry `toolclipReread: { path, count }` (same spirit as the `grew` flag), so a run analysis flags the distill-refetch loop directly instead of needing session archaeology. Purely diagnostic: LLM-facing content and cache behavior are untouched. The counter resets at each round boundary.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS` | `1000` | Minimum estimated token count for a tool result to get a pending marker. Results at or below the threshold are left untouched. |
| `TOOLCLIP_STEERING_REMINDER` | `true` | Inject a trailing steering reminder when either steering trigger fires (count or size), listing the pending ids with their sizes. |
| `TOOLCLIP_STEERING_COUNT_THRESHOLD` | `5` | Count trigger: the reminder fires when the number of un-replaced pending results strictly exceeds this, and re-arms when the count falls back to it or below (one nag per excursion). |
| `TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS` | `5000` | Size trigger: the reminder also fires when the pending pile's total estimated tokens strictly exceed this, re-arming on the same rule. Independent latch from the count trigger — catches a single huge un-replaced result (count of 1), which the count trigger is structurally blind to. |
| `TOOLCLIP_QUARANTINE` | `true` | Withhold results above the quarantine threshold (payload held for one turn, retrievable via `read_quarantined_result`). Disable to fall back to plain pending markers for all sizes. |
| `TOOLCLIP_QUARANTINE_THRESHOLD_TOKENS` | `10000` | Minimum estimated token count for a tool result to be quarantined. Well above the pending threshold: routine large results (1k–10k) just get pending markers. |

The max-replacement-ratio gate is intentionally **not** reintroduced: `replace_tool_result` accepts a replacement of any size and records a `grew` flag when a replacement is at least as large as its original — the observation target for reintroducing a length gate later.

**Token estimation.** Token counts come from [`tokenx`](https://github.com/johannschopplich/tokenx) — a zero-dependency, 2kB heuristic estimator calibrated against OpenAI's `o200k_base` tokenizer (~95% average accuracy; measured on real glm sessions it tracks reported prompt tokens within ~6% mean error for tool-result-sized content, where the previous chars/4 heuristic was off by ~10%). The same estimator drives the pending-marker counts, both thresholds, and the replacement size reports. There is deliberately **no runtime calibration**: an earlier attempt learned a chars/token divisor from `usage` each turn, and it could not converge — the pairing between "what we counted" and "what the provider reported" cannot cover the real prompt composition (tool-call arguments, per-message serialization overhead, provider cache quantization), so the divisor drifted with session shape (to ~35 before a scope fix, then to ~3.4 after it). A static, consistent estimate plus threshold margins is the simpler and more predictable shape.

**Space-free counterweight.** tokenx prices dense machine text at ~7 chars/token while real billing for base64 is ~1.5 chars/token — the 2026-09-20 golden run's 43.7k-char base64 `head` result was estimated at 6,260 tokens, billed at ~29,700, and slipped under the quarantine threshold to ride the context un-replaced. The estimator therefore adds a space-density counterweight: every maximal run of ≥ 20 non-whitespace characters keeps the tokenx price for its first 20 characters, and every character beyond that adds 0.5 tokens (2 chars/token). Detection is by lack of whitespace (cheaper and more robust than entropy measurement): prose and code see whitespace every few characters; base64, hex, minified code, and long URLs run on for hundreds without one. Spaced text is priced exactly as tokenx prices it; the golden-run blob now estimates at ~30k (billed ~29.7k) and quarantines. Overestimating dense text is the safe direction: the failure it causes (an occasional unnecessary quarantine) is cheap, the failure it prevents is the expensive one.

## Why this is separate from sesclip

Sesclip compacts the **entire** session context when it crosses a threshold. Toolclip is targeted — it touches **individual tool results**, and only when the LLM chooses. Different thresholds, different prompts, different mechanics. Combining them would muddle two distinct products.

## Out of scope (deferred)

- Retrieval tools (`get_tool_result`, `grep_tool_result`, pagination).
- Full tokenizer dependency (a vocab-carrying tokenizer like `gpt-tokenizer` is not worth its bundle size here — tokenx's heuristic is accurate enough for gating decisions).
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
