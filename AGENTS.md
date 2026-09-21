# toolclip

Targeted context reduction for individual tool results in pi coding agent sessions.

This project is a standalone pi extension: when a tool returns a long result, it appends a marker the LLM can act on, and the LLM may call `replace_tool_result(id, replacement)` to swap that bulky result for a tight replacement in subsequent turns. The LLM is the only actor. There is no auto-summarizer and no auto-eviction.

## Why this is separate from sesclip

Sesclip compacts the **entire** session context when it crosses a threshold. Toolclip is targeted — it touches **individual tool results**, and only when the LLM chooses. Different thresholds, different prompts, different mechanics. Combining them would muddle two distinct products.

## The Extension

The extension lives at `src/toolclip.ts` and follows the Semblr split: a thin pi extension entrypoint in `src/`, reusable logic in `lib/`. It:

- Listens to the `tool_result` event; appends a `[tool-result-pending-replacement: toolCallId=id, tokens=N]` marker to the LLM-facing content only of results strictly above the token threshold (default 1000) (the original stays intact). The max-replacement-ratio gate stays removed — replacements of any size are accepted.
- Registers a `replace_tool_result(toolCallId, replacement)` tool the LLM can call at its leisure. **No length gate is applied** — replacements of any size are accepted, and the tool records a `grew` flag (`replacementTokens >= originalTokens`) in its details as the observation target for reintroducing a gate later. A call that stores at least one replacement mints a **receipt** (`prefix + random base36 tag + counter`, e.g. `rp7k2-3`; lib/receipt.ts): the echo header becomes `Receipt rp7k2-1: stored N replacement(s) (call <callId>). ...` in pointer mode (copy mode keeps the old header), and the details carry `{ mode, receiptId, replaceCallId }` (receipt fields only when something was stored). Each replaced entry is stamped with the storing call's `replaceCallId` and `receiptId`; a re-replacement overwrites both. A nothing-stored call (all ids expired or unknown) mints no receipt and leaves the counter untouched.
- Listens to the `context` event; before each LLM call, swaps any `ToolResultMessage` whose `toolCallId` has a stored replacement. **Pointer mode** (default): the replacement text is kept exactly ONCE in context — in the model's own replace call arguments, never modified — and the original becomes a one-block pointer naming that call and its receipt: `[tool-result-replaced: toolCallId=id; summary is the replacement text for this id in your replace_tool_result call <callId>, receipt <rid>]`, built from `presentCallIds` (the ids of `replace_tool_result` toolCall blocks in the event's messages, rebuilt per event). A pointer is only applied while its target call is present; otherwise the swap falls back to the copy form `[replacement]\n[tool-result-replaced: toolCallId=id]` — a pointer must never dangle (compaction, a fork, or another extension can remove the call). **Copy mode** (`TOOLCLIP_REPLACEMENT_MODE=copy`) always uses the copy form. This is the cache-break point — known and accepted.
- Injects a **steering reminder** through **pi's native steering** (`sendUserMessage(..., {deliverAs: "steer"})` from the `turn_end` handler) when the pending mass crosses a rung of a single **Fibonacci ladder**. Eligibility: a pending entry counts only if its `toolCallId` is in the messages of the most recent `context` event — the extension records that id set in runtime state at each context event (state only; the handler stays a pure view transform). A result marked during the current turn is not yet in the last context event, so it is not eligible until the model has had one response to act on it; entries compacted away are no longer in the messages and stop counting (their tracker entries are removed — there is nothing left in context to swap; replaced entries always stay for the swap). The mass is `pileTotal`, a stored total maintained by the expiry accounting: entries join it at their first eligible turn boundary, a storing replace call or compaction recomputes it over the remaining tracked entries, and expiry never modifies it. Rungs sit at round(first × F(k)/5) for F = 5, 8, 13, 21, 34, 55, 89, ... — 5000, 8000, 13000, 21000, 34000, 55000, 89000, ... at the default first rung (`TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS`, whose name predates the ladder and is kept). Comparison is strict: a total equal to a rung does not cross it. A single ratchet integer `level` (rungs already announced) starts at 0 each round: crossing to a higher count fires **one** nag — even across several rungs at once — and raises the level; when the mass falls below an announced rung (replacements or compaction), the level re-arms down, so a re-grown pile is nagged again. The ladder replaced the earlier pair of flat thresholds (count > 5 / total > 5000 with independent latches): one size-only rule covers both the many-small-items and the single-huge-blob shapes, because both are just mass. The message summarizes the live pile ("you have N tool-result-pending-replacements totalling ~T estimated tokens") and lists exactly the live tracked pending ids with their sizes — surfacing a single huge hog at a glance. The steer is **persisted as a real user message** at the next turn boundary: part of the session's message list, visible in every subsequent LLM call, included in compaction/summarization — this replaces the earlier synthetic context append, which was consumed for a single LLM call and never written to the session (the post-fix golden run of 2026-09-20 showed the model seeing each nag exactly once while the pile stayed above the rungs for 119 consecutive calls). Observation happens at `turn_end` (after the turn's tool results are in — freshest pile state at the boundary; pi polls the steering queue immediately after, so the nag is visible from the very next LLM call). The level resets at each round boundary in `before_agent_start`, so a pile persisting into a new round is re-announced at that round's first turn boundary.
- **Expires stale pendings** at `turn_end` (when the turn's usage is readable from the assistant message's pi `Usage` block — `{input, output, cacheRead, cacheWrite, cost}`; a turn without usable usage changes nothing). A pending result older than the point where replacing it still pays back is expired: replacing it would rewrite more cached suffix than it saves. Accounting: `turnsSeen` (never reset per round); EMA-measured prices `rho`/`w` (cache-read / cache-write price as a ratio of the uncached-input price), starting at config priors, observations floored at 100 tokens and discarded whole on negative/non-finite readings; a no-cache streak; the running mean replacement size. Each pending entry becomes counted at its first eligible turn boundary (size joins `pileTotal`, `ctxSeen` fixes the context size); the pay-back test per tracked entry: net = originalTokens − COPIES×R − OVERHEAD (R = measured mean once 3 replacements are seen, clamped [50, 1000], else prior), H = clamp(turnsSeen, 10, 100); replacing pays iff S_i ≤ rho/(w−rho) × net × H. Expired entries are deleted from the tracker, dropped from the nag, and a replace call naming one is silently ignored (`ok: true, ignored: "expired"` — never an error; text lists only stored items, or "Nothing to replace."). Expiry is monotone (never re-armed) and never modifies `pileTotal` — expired mass stays until the next reset (a storing replace call or compaction), so expiry can neither fire nor re-arm the ladder. Three consecutive no-cache turns freeze expiry (phi = ∞). With `TOOLCLIP_EXPIRY_ANNOUNCE` the next nag lists newly expired ids once ("Expired (no longer worth replacing; leave them): ...", capped at 20). Expired originals stay in context untouched.
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
| `TOOLCLIP_STEERING_REMINDER` | `true` | Whether to deliver steering reminders when the eligible pending mass crosses a ladder rung. |
| `TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS` | `5000` | First rung of the steering ladder: the nag fires once the eligible pending mass strictly exceeds this, then at each higher Fibonacci rung (1.6×, 2.6×, 4.2×, 6.8×, ...). One ratchet (`level`) nags once per crossing, re-arms down when the mass falls below an announced rung, and resets at each round boundary. The env var's name predates the ladder and is kept. |
| `TOOLCLIP_QUARANTINE` | `true` | Whether oversized results are quarantined (payload held until read, retrievable via `read_quarantined_result`). Disable to fall back to plain pending markers for all sizes. |
| `TOOLCLIP_QUARANTINE_THRESHOLD_TOKENS` | `10000` | Minimum estimated token count for a tool result to be quarantined. Must sit well above the pending threshold. |
| `TOOLCLIP_EXPIRY` | `true` | Master switch for expiry of stale pending entries. `false`: no expiry — ladder-only. |
| `TOOLCLIP_EXPIRY_RHO` | `0.2` | Prior for the cache-read price / uncached-input price ratio; replaced by the EMA-measured value. |
| `TOOLCLIP_EXPIRY_WRITE_RATIO` | `1.0` | Prior for the cache-write price / uncached-input price ratio (1.25 on Anthropic-style pricing). |
| `TOOLCLIP_EXPIRY_REPLACEMENT_TOKENS` | `170` | Prior for the assumed replacement size until 3 replacements are measured. |
| `TOOLCLIP_EXPIRY_REPLACEMENT_COPIES` | `1` (pointer) / `2` (copy) | Copies of the replacement text in context for the expiry formula; explicit env value wins. |
| `TOOLCLIP_EXPIRY_OVERHEAD_TOKENS` | `95` (pointer) / `60` (copy) | Fixed tokens per replacement not otherwise counted; explicit env value wins. |
| `TOOLCLIP_EXPIRY_HORIZON_MIN_TURNS` | `10` | Floor of H, the expected remaining turns in the pay-back test. |
| `TOOLCLIP_EXPIRY_HORIZON_MAX_TURNS` | `100` | Cap of H. |
| `TOOLCLIP_EXPIRY_ANNOUNCE` | `true` | List newly expired ids once in the next nag. |
| `TOOLCLIP_REPLACEMENT_MODE` | `pointer` | `pointer`: replacement text kept once (in the replace call's args), the original becomes a pointer to it with a copy-form fallback when the target call is gone. `copy`: summary in both places (A/B baseline). |
| `TOOLCLIP_POINTER_INCLUDE_CALL_ID` | `true` | Include the replace call's toolCallId in the pointer text; the receipt is always included. |
| `TOOLCLIP_RECEIPT_PREFIX` | `"rp"` | Prefix of the receipt id. |
| `TOOLCLIP_RECEIPT_TAG_LENGTH` | `3` | Random base36 tag chars generated per extension load (resume-uniqueness); `0` disables the tag. |

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
- Tracker-entry lifecycle: entries are deleted only by compaction (counted, pending entries whose id left the most recent context's messages) or expiry (stale tracked entries). Replaced entries are never deleted — the context swap needs them. Entries marked during the current turn are never compacted (not counted yet). A re-marked (re-recorded) id resets its counted state and corrects `pileTotal`.
- Expiry invariants: expiry never modifies `pileTotal` (the ladder's total) and never fires or re-arms the ladder; it is monotone (expired ids are never re-armed); a replace call naming an expired id must NOT fail (`ok: true, ignored: "expired"`) — the model must not be punished for working from an older nag's list; expired originals stay in context untouched. The nag lists live tracked entries only (never `pileTotal`, which may carry expired mass until its next reset) and, with announce on, lists newly expired ids exactly once.
- The steering reminder is delivered via pi's native steering (`sendUserMessage(..., {deliverAs: "steer"})` from the `turn_end` handler): observed when the eligible pending mass crosses to a higher Fibonacci rung than already announced (first rung 5000 by default, strict comparison, one nag per crossing, re-arm down on shrinkage). It must stay **persisted** (a real user message in the session, visible on every later call) — never move it back to a synthetic append in the `context` handler: that array is consumed for exactly one provider call and never written to the session, so the nag flashes once and vanishes. The level resets at each round boundary (`before_agent_start`).
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
