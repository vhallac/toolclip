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
5. **Steering reminder.** If the agent leaves marked results un-replaced, toolclip observes the pile at each `turn_end` (after the turn's tool results are in). Eligibility: a pending entry counts only if its `toolCallId` appears in the messages of the most recent `context` event — a result marked during the current turn is not yet eligible (the model has not had a response to act on it), and entries compacted away have left the messages, stop counting, and are removed from the tracker (there is nothing left in context to swap; replaced entries are always kept for the swap). The pending **mass** — `pileTotal`, a stored total maintained by the expiry accounting (item 6): entries join it when they first become eligible at a turn boundary, a storing replace call or compaction recomputes it over the remaining tracked entries, and expiry never modifies it — is compared against a single **Fibonacci ladder**: rungs at 5000, 8000, 13000, 21000, 34000, 55000, 89000, ... (rung(k) = round(first × F(k)/5) with F = 5, 8, 13, 21, 34, 55, 89, ...; `TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS` — kept for compatibility — now means the **first rung**). Comparison is strict: a total equal to a rung does not cross it. One ratchet integer `level` (rungs already announced) starts at 0 each round: crossing to a higher rung count fires **one** nag — even when several rungs were crossed at once — and raises the level; when the total falls below an announced rung (through replacements or compaction), the level re-arms down, so a re-grown pile is nagged again. The ladder subsumes the earlier pair of flat thresholds (count > 5, total > 5000, independent latches): one size-only rule covers both the many-small-items and the single-huge-blob failure shapes, because both are just mass. Delivery is through **pi's native steering** — `sendUserMessage(..., {deliverAs: "steer"})`. Pi persists the steer as a real `user` message at the next turn boundary: it becomes part of the session's messages, is visible in every subsequent LLM call, and is included in compaction/summarization — until the pile is distilled. The reminder summarizes the live pile — "you have N tool-result-pending-replacements totalling ~T estimated tokens" — and lists exactly the live tracked pending ids with their sizes (never the expired ones) so the agent can act in one batched call. The level resets at each round boundary, so a pile persisting into a new round is re-announced at that round's first turn boundary. (A pile above the announced rungs at a run's final turn forces one more turn — the model must at least see the nag.)
6. **Expiry of stale pendings.** A pending result older than the point where replacing it still pays back is *expired* — replacing it would rewrite more cached suffix than it saves over the expected remaining turns. At each `turn_end` (when the turn's usage is readable from the assistant message's pi `Usage` block; a turn without usable usage changes nothing) the extension maintains the accounting: `turnsSeen` (turns observed, never reset per round), EMA-measured prices `rho` (cache-read price / uncached-input price) and `w` (cache-write price / uncached-input price) starting at the config priors and clamped observations (token floors 100, garbage cost readings discarded whole — some routers log negative costs), a no-cache streak, and the running mean size of stored replacements. Every pending entry becomes **counted** at the first turn boundary where it is eligible; at that moment its size joins `pileTotal` (the ladder's mass) and its `ctxSeen` fixes the request context size, so the tokens appended since (S_i = ctx_t − ctxSeen) measure how much cached suffix a replacement would now rewrite. The per-entry pay-back test: net_i = originalTokens − COPIES×R − OVERHEAD (the per-turn saving; R is the measured mean replacement size once 3 replacements are seen — clamped to [50, 1000] — else the prior) and H = clamp(turnsSeen, 10, 100) (expected remaining turns); replacing pays iff S_i ≤ rho/(w−rho) × net_i × H. Past that point — or when net_i ≤ 0 — the entry is expired: deleted from the tracker, dropped from the nag, and any replace call naming it is **silently ignored** (`ok: true, ignored: "expired"` — never an error; the model must not be punished for working from an older nag's list, and the result text lists only stored items, or "Nothing to replace."). Expiry is monotone (an expired id is never re-armed) and **never modifies `pileTotal`** — expired mass stays in the total until the next reset (a storing replace call or compaction), so expiry can neither fire nor re-arm the ladder. Three or more consecutive turns with no cache activity freeze expiry (phi = ∞): with no cache there is no pay-back to model. When `TOOLCLIP_EXPIRY_ANNOUNCE` is on, the next nag lists newly expired ids once — "Expired (no longer worth replacing; leave them): ..." — so the model stops chasing ids it can no longer act on. Expired originals stay in context untouched; nothing is swapped.
7. **Quarantine.** Results above a much higher threshold (default 10000 tokens) are withheld from the LLM entirely: the content is swapped for a notice
   ```
   [tool-result-quarantined: toolCallId=abc, tokens=12000]
   ```
   and the payload is held aside until read — "held until read; freed after reading". The agent first sees the notice in the turn after the quarantine (pi delivers a turn's tool results at that turn's end, so it cannot react within the same turn), but the notice starts no countdown: a `read_quarantined_result({ toolCallId })` call is honored at any later turn — even as one of several tool calls in the batch. A read releases (destroys) the payload; a later read attempt for the same id is denied with an "already read" `[quarantine-missed: ...]` notice, and a read for an id that was never quarantined is denied with a "never held" notice that points at the pending-marker distillation path. The read's own result re-enters the normal pending-marker path (it is replaceable), and is never re-quarantined. Held payloads survive round boundaries.

   Both the notice and the system-prompt section frame the choice as part-vs-whole: need only part of the data → re-issue a narrower call; need the whole payload → read it from the quarantine **once**. Reconstructing the payload piecemeal (offset/limit chunks, repeated narrowed calls) costs more calls and more tokens than one full read and is explicitly forbidden. The wording is deliberately free of deadline urgency ("your very next response", "only chance") — that urgency made the model defer the read behind a steering nag, and the former one-turn eviction then destroyed the payload it still needed.

   Why no eviction: the session file holds only the notice — the in-memory payload is the only copy, so the former one-turn window ("use it or lose it") was permanent data destruction. In the 2026-09-20 golden run it collided with the steering nag (the nag consumed the read-window turn; the eviction then destroyed a 14.7k-token payload the model genuinely needed, which it re-fetched in 11 piecemeal reads). Held payloads cost a few hundred KB of host RAM per run at most — RAM is not the scarce resource; irreversibly destroyed context is.
8. **Re-read observation.** Successful `read` results are counted per path within the round. From the second read of the same path — consecutive or not — the result's `details` carry `toolclipReread: { path, count }` (same spirit as the `grew` flag), so a run analysis flags the distill-refetch loop directly instead of needing session archaeology. Purely diagnostic: LLM-facing content and cache behavior are untouched. The counter resets at each round boundary.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS` | `1000` | Minimum estimated token count for a tool result to get a pending marker. Results at or below the threshold are left untouched. |
| `TOOLCLIP_STEERING_REMINDER` | `true` | Deliver a steering reminder via pi's native steering when a ladder rung is crossed, listing the eligible pending ids with their sizes. |
| `TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS` | `5000` | First rung of the steering ladder: the nag fires once the eligible pending mass (total original estimated tokens of pending entries present in the most recent context event's messages) strictly exceeds this, then at each higher Fibonacci rung (1.6×, 2.6×, 4.2×, 6.8×, ... — 8000, 13000, 21000, 34000, ... by default). One ratchet (`level`) nags once per crossing, re-arms down when the mass falls below an announced rung, and resets at each round boundary. The env var's name predates the ladder and is kept. |
| `TOOLCLIP_QUARANTINE` | `true` | Withhold results above the quarantine threshold (payload held until read, retrievable via `read_quarantined_result`). Disable to fall back to plain pending markers for all sizes. |
| `TOOLCLIP_QUARANTINE_THRESHOLD_TOKENS` | `10000` | Minimum estimated token count for a tool result to be quarantined. Well above the pending threshold: routine large results (1k–10k) just get pending markers. |
| `TOOLCLIP_EXPIRY` | `true` | Master switch for expiry of stale pending entries. `false`: no expiry — ladder-only; entries are kept until replaced or compacted away. |
| `TOOLCLIP_EXPIRY_RHO` | `0.2` | Prior for the cache-read price as a ratio of the uncached-input price. Replaced by the EMA-measured value once usage costs flow. |
| `TOOLCLIP_EXPIRY_WRITE_RATIO` | `1.0` | Prior for the cache-write price as a ratio of the uncached-input price (1.25 on Anthropic-style pricing). |
| `TOOLCLIP_EXPIRY_REPLACEMENT_TOKENS` | `170` | Prior for the assumed replacement size (tokens) until 3 stored replacements have been measured. |
| `TOOLCLIP_EXPIRY_REPLACEMENT_COPIES` | `2` | Copies of the replacement text in context: 2 while the replace call's args are kept (args + swapped result), 1 after a future arg stubbing. |
| `TOOLCLIP_EXPIRY_OVERHEAD_TOKENS` | `60` | Fixed tokens per replacement not otherwise counted (call block, ids, echo). |
| `TOOLCLIP_EXPIRY_HORIZON_MIN_TURNS` | `10` | Floor of H, the expected remaining turns in the expiry pay-back test. |
| `TOOLCLIP_EXPIRY_HORIZON_MAX_TURNS` | `100` | Cap of H. |
| `TOOLCLIP_EXPIRY_ANNOUNCE` | `true` | List newly expired ids once in the next nag ("Expired (no longer worth replacing; leave them): ..."). |

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
