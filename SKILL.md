---
name: monitor
description: when troubleshooting long-running processes, builds, deploys, log streams, CI pipelines. Reversible fixes as errors appear. MCP-compatible. Not for short-lived tasks.
---

> **Snapshot:** This skill contains hand-authored operational guidance and local TypeScript companion scripts. There is no vendored documentation snapshot.

# GG → Monitor → Operating Loop

This skill is the canonical script for running an *active* monitoring session.
"Active" means: the model arms streaming watchers, heartbeats to the user,
triages events as they arrive, dispatches sub-agents to fix reversible
problems, verifies each fix, and reports at the end. It is
**subject-agnostic** — the same loop for a profile-ingestion CLI, a Bun build,
a log tail, or a CI pipeline.

It is not a passive log viewer. It is a co-pilot that the user trusts to act
on the events they would have acted on themselves.

For a direct command lookup, see [Quick Commands](#quick-commands) below.

## When to Use This Skill

**TRIGGER when:**
- The user explicitly says "monitor X", "watch X", "babysit X", "tail X", or "keep an eye on X".
- The user says "run X and tell me if anything breaks" or "if anything fails, fix it".
- The operation takes more than ~2 minutes wall-clock and the user is waiting for an unpredictable outcome.
- Errors during the operation are likely and partly reversible.

**SKIP when:**
- The user only wants a one-off status check ("is the build done?").
- The user wants to debug a process that has already finished.
- The task is a single quick command with a predictable result under 30 seconds.

## Quick Commands

```bash
# Generate a grep pattern from recent log errors
npx tsx skills/monitor/scripts/monitor-suggest-filter.ts /path/to/log 500

# Classify a single log line
echo "ERROR connect ECONNREFUSED 127.0.0.1:3001" \
  | npx tsx skills/monitor/scripts/monitor-classify-error.ts

# Claim file locks before dispatching a sub-agent
npx tsx skills/monitor/scripts/monitor-dispatch-queue.ts \
  --claim "lib/db.ts,lib/cache.ts" --agent-id agent_42
```

For the full script surface, env vars, and exit codes, see `references/script-inventory.md`.

## Common Misconceptions

| # | Misconception | Correction | Key concept |
|---|---------------|------------|-------------|
| 1 | Silence on the stream means everything is fine. | Silence reads as "asleep" or "stuck". The heartbeat must continue even when nothing changes. | Heartbeat discipline |
| 2 | A sub-agent reporting "done" means the fix is verified. | Sub-agents describe intent, not outcome. Always re-check the stream, run a smoke test, and inspect the commit. | Verify, don't trust |
| 3 | A fast 502 and a slow 502 have the same root cause. | Fast 502 (~ms) means upstream is dead; slow 502 (~timeout) means upstream was busy. Different fixes. | Timing-aware triage |
| 4 | Two sub-agents can safely run in parallel on the same files. | Parallel pushes to the same branch will conflict. Sequence them or use file-allowlist locks. | Dispatch isolation |
| 5 | The monitor should poll with quick foreground Bash calls every few seconds. | Use `Monitor` for streaming; foreground Bash is for one-shot probes only. Polling wastes context. | Tool selection |
| 6 | Any error should trigger immediate sub-agent dispatch | Classify severity first; not all errors are reversible | Severity triage |
| 7 | Monitor should run indefinitely | Set explicit end conditions and timeout | Bounded monitoring |

## Preconditions (verify before starting)

1. The user named (or implied) a single concrete *thing* being monitored.
   Examples: "the ingestion run", "the deploy log", "PR #123 checks". If the
   scope is vague, ask one clarifying question and stop.
2. There is a stable source of truth you can stream from — a log file, a
   process's stdout, an API health endpoint, a `gh` poll. If you cannot point
   at the source, stop and ask the user where to look.
3. You know what success and failure *look like* on that stream. If you only
   know what success looks like, broaden your filter (see Watcher Coverage
   below) — silence reads as "asleep" or "stuck", never as "all good".

## Repo conventions

- Apply repository guidance from the canonical `AGENTS.md`. Treat `CLAUDE.md`
  and `GEMINI.md` as routing stubs back to `AGENTS.md`.
- Per `AGENTS.md`: do **NOT** start the platform yourself. If a watched service
  is unresponsive, prompt the user to start it.
- Per memory `feedback_always_commit_push.md`: never leave uncommitted work.
  Commit + push after every fix. Sub-agents inherit the same rule.
- Per memory `feedback_chrome_tabs_not_preview.md`: when the watched thing is a
  web app, verify via Chrome MCP tabs, not preview tools that kill local-edge.

## The operating loop

### 1. Arm a streaming watcher on the source of truth

Use the `Monitor` tool against a `tail -F | grep --line-buffered <pattern>`
or equivalent poll loop. The filter must match every line a human would act
on, not just the success marker.

**Watcher Coverage rule.** If the watched process crashed right now, would
your filter emit anything? If not, widen it. Better to log some benign noise
than to be silent through a crashloop.

Concrete pattern (substitute any other source — file, endpoint, command):

```
tail -F /path/to/log | grep -E --line-buffered \
  "ERROR|FATAL|Traceback|exception |panic|crash|Killed|OOM|\
EADDRINUSE|ECONNREFUSED|EPIPE|ENOTFOUND|MongoError|UND_ERR|\
HTTP/1\\.1\" 5[0-9][0-9]| 5[0-9][0-9] / |SLOW DB WRITE|\
aborted|ECONNRESET|RST_STREAM|<your-domain-warns-here>"
```

For an unknown log shape, use the companion script to extract high-signal
tokens automatically. See [Quick Commands](#quick-commands).

When `Monitor` reports `[N events suppressed — output rate too high]`, that's
a signal the filter is too loose. Stop the monitor with `TaskStop` and re-arm
with a tighter filter excluding the noisy line shape (`grep -v` after the
positive match). Pipe the suppressed lines back into the suggest-filter script
(via stdin with `-`) to generate a tightened pattern automatically.

For one-shot waits ("tell me when the build finishes") use Bash with
`run_in_background: true` and an `until` loop instead — `Monitor` is for
*every* event, not single completions.

### 2. Heartbeat to the user every ~20 seconds

One sentence per beat. Pattern:

```
HH:MM:SS — <what changed since last beat | "still nothing, system is X">
```

Don't pad. If nothing's changed, say so explicitly — silence reads as
"asleep" or "stuck". When a meaningful event lands, that *is* the heartbeat
for that interval — you don't need a separate "still alive" line on top.

**Show the lines.** When the user is following along, paste the actual log
lines you saw as fenced code blocks, with the timestamp prefix. Don't
paraphrase. The user is watching the same stream and wants confirmation you
are seeing what they are seeing.

### 3. Track work with TodoWrite

One item per fix in flight. One item for the heartbeat itself if the
operation will run long enough that you need to remind yourself it is
ongoing. Mark items done the *moment* they verify, not when dispatched.

### 4. When a new error class appears, triage into one of three states

- **Crash / blocking** → fix now, autonomously if reversible.
- **Persistent warning** → flag, optionally fix, never if it touches
  shared state.
- **Transient / mid-restart** → note it, watch one cycle to confirm it
  self-heals, then move on without touching it.

Distinguishing slow 502 from fast 502 is the canonical example: a fast 502
(ms) means upstream is dead; a slow 502 (≈timeout) means upstream was busy
when the proxy gave up. Different fixes.

For high-event storms, pipe each new error line through the companion
classifier to cut decision fatigue. See [Quick Commands](#quick-commands).

### 5. Decide autonomous vs flag

- **Reversible local change** (code edit, dep install, cache clear,
  config rerender + reload): dispatch a sub-agent with a self-contained
  brief and let it commit + push.
- **Shared-state change** (production DB, public service, shared infra,
  destructive ops): DO NOT act. Flag it for the user with what you'd do
  and the evidence supporting each option. Wait.
- **Transient noise that recovers on its own** (one-shot 500 during
  restart, stale cache log line right after a deploy): note, watch one
  cycle, then move on without touching it.

If unsure, lean toward flag-for-user. The cost of a false-positive
autonomous fix is much higher than the cost of waiting for one
confirmation.

### 6. Brief sub-agents like cold colleagues

A sub-agent has none of your conversation context. The brief must include:

- The exact error string you observed (verbatim, with timestamp).
- Repo + submodule paths, the `AGENTS.md` files to read, file:line
  pointers to the suspected call sites.
- What you've already ruled out.
- What success looks like (test command, log line that should disappear,
  metric that should change).
- What NOT to touch — adjacent code that would explode the diff,
  workspace drift to ignore, the platform-restart prohibition.
- Standing rules: commit conventions (`fix(scope):`, `perf(scope):`),
  the sign-off footer, the always-commit-and-push rule, the strict-TS
  rules, ESLint constraints, etc.
- A self-verification step (`tsc --noEmit`, targeted test pattern).
- A reporting contract: "report back under N words: file:line, commit
  SHA, related call sites you also fixed (or noticed but deliberately
  left alone, with reason), tests run + result".

Run sub-agents in the background when their work doesn't block the next
decision. **Do not run two sub-agents in parallel that touch overlapping
files** — push conflicts are painful to recover from mid-session. If you
must overlap, give each a strict file allowlist and instruct them to
rebase.

For the reusable brief template and lock mechanics, see
`references/subagent-brief-template.md`.

`SendMessage` may not be available in all harnesses; if you need to
correct a sub-agent mid-flight, your options are usually to wait for it
to finish (verify, don't trust will catch its miss) or kill and respawn
with the corrected brief.

### 7. Verify, don't trust

When a sub-agent reports done, confirm independently:

1. The error class is gone from the stream.
2. The functional path works (curl, smoke test, targeted test, whatever
   fits).
3. The claimed commit SHA exists on the remote (`git log --oneline -3`,
   `git fetch && git log origin/main --oneline -3`).
4. Type-check / lint is clean for the touched paths.

A sub-agent's summary describes what it intended to do, not what it
actually did. The verification step catches the gap.

### 8. Stop conditions

Stop the watcher only when:

- The user says so explicitly.
- The underlying operation ends (the watched stream emits its
  natural completion event — `Queue run finished`, `Build succeeded`,
  exit code).
- You hit a hard-failure state that requires user authorization to
  proceed (don't loop on an authoritative blocker).

**Errors that arrive while waiting on the user are not the user's
reply.** Acknowledge them but keep the floor with the user.

### 9. End-of-session report

When the operation ends — or when the user closes the loop — produce
one consolidated report distinguishing:

- "I fixed this" (link the commit SHA).
- "I dispatched a sub-agent that fixed this" (link the SHA + which
  agent).
- "I'm waiting on the user to authorize this" (with what you'd do).

Include wall-time and before/after metrics where they exist. Be honest
about variance.

For durable reporting, use the companion session-log scripts. See
`references/session-log-format.md` for the NDJSON schema and
`references/script-inventory.md` for usage.

## Command Decision Guide

| Scenario | Recommended tool |
|----------|----------------|
| Stream every actionable line from a log or process | `Monitor` with `tail -F \| grep -E --line-buffered` |
| Wait once for a completion event ("build done") | `Bash run_in_background: true` with `until` loop |
| Kill a noisy or stale watcher | `TaskStop` |
| Dispatch a fix to a background sub-agent | `Agent` (background) with a self-contained brief |
| Track in-flight fixes | `TodoWrite` |
| One-shot probe (curl, git log, ps) | `Bash` (foreground) |

**Rule of thumb:** If the source produces a stream of events, use `Monitor`. If you need a single answer, use `Bash`.

## Anti-patterns

- **Polling with quick foreground Bash calls** every few seconds. The
  Monitor is doing this for you; your job is to react to events, not
  re-list the same state.
- **Repeating identical heartbeats** ("same 502, no change", three in
  a row). Once is enough; then stay silent until something changes.
- **Overselling a win** because one task ran fast. Wait for 3-5 data
  points before claiming a multiplier.
- **Acting on a "fast 502" the same way as a "slow 502"**. Read the
  timing. They mean different things.
- **Forgetting to verify a sub-agent's claim**. They sometimes report
  green when their last commit is broken. Always re-check `tsc`, the
  health endpoint, and `git log`.
- **Dispatching two sub-agents at the same time on overlapping files**.
  Both will push to `main`; the second push will fail and the recovery
  is messy. Sequence them.
- **Running `npm run local`**. Per repo policy, the platform is already
  running with hot reload. If a service is unresponsive, ask the user
  to start it.

## Blocking gates

1. Do not act on shared-state changes (production DB, shared infra)
   without explicit user confirmation in this turn.
2. Do not skip the heartbeat — the user explicitly relies on it to
   know you're alive.
3. Do not declare success on a sub-agent fix without independent
   verification (the error class is gone from the stream AND the
   functional path works).
4. Never reconstruct shell commands, CLI flags, or setup steps from
   memory — always read the relevant script source or reference file
   first.
5. Do not run two sub-agents in parallel on overlapping files without
   claiming locks first.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Monitor suppresses events with "output rate too high" | Filter is too loose | Stop the monitor, pipe suppressed lines through `monitor-suggest-filter.ts -`, and re-arm with the tightened pattern. |
| `monitor-dispatch-queue.ts` returns BLOCK for every claim | A previous agent crashed without releasing its lock | Manually remove `.tmp/monitor-dispatch-queue/*.lock` and the orphaned `.claim` file, then re-claim. |
| `monitor-report.ts` prints "none" for every section | Session log path is wrong or the log file is empty | Verify the `MONITOR_SESSION_LOG` env var or the auto-generated `.tmp/monitor-*.ndjson` path. |
| `monitor-classify-error.ts` returns `unknown` for a known error | The error pattern is not in the rule set | Add the pattern to `scripts/monitor-classify-error.ts` and re-run, or triage manually. |
| Sub-agent fix verified locally but error reappears on stream | The fix addressed a symptom, not the root cause | Widen the watcher filter to catch earlier events, then dispatch a deeper-debugging sub-agent. |

## Companion skills

Two patterns commonly accompany an active monitoring session. Reference
them descriptively — by *kind*, not by id — so the host harness can
auto-resolve a matching skill from whatever is installed.

- A **deeper-debugging skill** is helpful when the monitored process
  fails repeatedly and a single sub-agent brief is not enough to
  diagnose the root cause. The monitoring loop hands off the
  diagnosis with the same operating-loop discipline (heartbeat,
  triage, verify-don't-trust) and resumes once the cause is known.
- An **expert-domain delegate skill** is helpful when the fix needs a
  delegate trained for a specific tool family (CLI agents, code
  generators, vision models, browser automation). The monitoring
  loop stays in charge of the session; the delegate handles the
  bounded subtask and returns control.

If neither kind of skill is installed, fall back to a plain
sub-agent brief per step 6 of the operating loop above.

## Monitor Quality Checklist

Use this checklist before and during any monitoring session.

| # | Checklist Item | Why It Matters | Gate |
|---|---------------|---------------|------|
| 1 | **Target named** — Concrete thing to monitor identified | Prevents scope creep | Pre-start |
| 2 | **Source identified** — Stable stream source confirmed | Enables streaming | Pre-start |
| 3 | **Success/failure criteria defined** — Know what outcomes look like | Prevents misinterpretation | Pre-start |
| 4 | **Heartbeat scheduled** — ~20 second interval set | Prevents silence misinterpretation | Active |
| 5 | **Error classification ready** — Three-state triage defined | Enables fast response | Active |
| 6 | **Dispatch isolation set** — File locks for parallel agents | Prevents conflicts | Active |
| 7 | **Fix verification planned** — Smoke tests ready for each fix type | Ensures fixes work | Active |
| 8 | **Timeout/end condition set** — Explicit stop condition defined | Prevents indefinite monitoring | Closeout |
| 9 | **Summary reported** — Events, fixes, outcomes documented | Closeout documentation | Closeout |

### Quality Tiers

| Tier | Criteria | Use When |
|------|----------|----------|
| **Minimal** | Items 1-3, 9 | Simple one-shot check |
| **Standard** | Items 1-6, 9 | Active monitoring with fixes |
| **Full** | All 9 items | Long-running monitoring with sub-agents |

### Pre-Start Verification

```
□ Concrete monitoring target named
□ Stable stream source identified
□ Success and failure criteria defined
□ Heartbeat interval set to ~20 seconds
□ Error triage states defined
□ File locks ready for parallel dispatch
□ Smoke tests ready for each fix type
□ Timeout and end condition set
```

## Monitor Consistency Validator

Before and during monitoring, verify:

### Consistency Check Matrix

| Check | What to Verify | How to Fix |
|-------|---------------|------------|
| **Stream vs Source** | Stream matches identified source | Re-identify source |
| **Heartbeat vs Silence** | Heartbeat continues even in silence | Add heartbeat |
| **Fix vs Verification** | Each fix has smoke test | Add verification |
| **Dispatch vs Locks** | File locks prevent parallel conflicts | Add locks |

### Red Flags (Never Present)

- [ ] No heartbeat during silence
- [ ] Sub-agent dispatched without verification plan
- [ ] Parallel agents without file locks
- [ ] No end condition or timeout
- [ ] Fix claimed done without smoke test

## Local Corpus Layout

`references/` is flat — no nested subfolders. Three hand-authored reference
files support the operating loop:

| File | Description |
|------|-------------|
| `script-inventory.md` | Full CLI signatures, flags, env vars, exit codes, and examples for all five companion scripts. |
| `session-log-format.md` | NDJSON event schema consumed by `monitor-session-log.ts` and `monitor-report.ts`. |
| `subagent-brief-template.md` | Copy-ready template for step-6 sub-agent dispatches, including file-lock commands. |
