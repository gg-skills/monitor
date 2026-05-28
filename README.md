# monitor
Active monitoring loop with sub-agent dispatch and verify-don't-trust.

This skill is the canonical script the model follows whenever the user asks it to *monitor* something — a long-running ingestion, a deploy, a build, a tail of logs, a CI pipeline, a polling job. It is **subject-agnostic**: same loop regardless of what is being monitored.

## Install

The fastest cross-agent install path is the `skills` CLI:

```bash
npx skills add gg-skills/monitor
```

Drop this skill into a workspace as a Git submodule for pinned versions, or as a plain clone for latest `main`:

```bash
# Project-local, version-pinned:
git submodule add git@github.com:gg-skills/monitor.git .claude/skills/monitor

# OR project-local, latest main:
mkdir -p .claude/skills
git -C .claude/skills clone git@github.com:gg-skills/monitor.git

# OR user-level, available in every project on this machine:
mkdir -p ~/.claude/skills
git -C ~/.claude/skills clone git@github.com:gg-skills/monitor.git
```

Restart your agent or reload skills after installation. See the parent [`skills` catalog repo](https://github.com/gg-skills/skills) for the full catalog.

## When to use

- The user says "monitor X", "watch X", "babysit X", "tail X", or "keep an eye on X".
- The user says "run X and tell me if anything breaks" or "if anything fails, fix it".
- The operation takes more than ~2 minutes wall-clock and the user is waiting for an unpredictable outcome.
- Errors during the operation are likely and partly reversible.

Skip when the user wants a one-off status check, post-mortem debugging of a finished process, or a single quick command under 30 seconds.

## How it operates

### Inputs

| Input | Description |
|-------|-------------|
| **Target** | A named, concrete thing to monitor: a log file, a process stdout, a CI pipeline, a health endpoint. The skill requires a stable source of truth before starting. |
| `MONITOR_QUEUE_DIR` | Directory for sub-agent dispatch lock files. Default: `.tmp/monitor-dispatch-queue`. Override in `.env` (copy `.env.example`). |
| `MONITOR_SESSION_LOG` | Path for the durable NDJSON session log. Default: `.tmp/monitor-<iso>.ndjson` (auto-generated per session). Override in `.env`. |
| `.env.example` | Template for both env vars above. Copy to `.env` and edit if the defaults conflict with your project layout. |

The skill arms after confirming three preconditions: (1) a single concrete target is named, (2) there is a stable streamable source of truth, and (3) success and failure signatures are known.

### Outputs

| Output | Description |
|--------|-------------|
| **Queue dir** (`MONITOR_QUEUE_DIR`) | `.lock` and `.claim` files written by `monitor-dispatch-queue.ts` to prevent overlapping sub-agent writes. Cleaned on release. |
| **Session log** (`MONITOR_SESSION_LOG`) | NDJSON file with one event per line: `triage`, `dispatch`, `heartbeat`, `verify`, `fix`, `flag-user`. Consumed by `monitor-report.ts` to produce the end-of-session markdown report. |
| **Heartbeat messages** | One-sentence status lines sent to the user every ~20 seconds while the watcher is live. |
| **End-of-session report** | Consolidated markdown distinguishing what the skill fixed (commit SHA), what a sub-agent fixed (SHA + agent id), and what is waiting for user authorization. |

### External commands

All five companion scripts live in `scripts/` and are called with `npx tsx`:

| Script | Purpose | Key env var |
|--------|---------|-------------|
| `monitor-suggest-filter.ts <logfile> [sample-lines]` | Generates a `grep -E` pattern from the highest-signal error tokens in a log sample. Pass `-` to read from stdin. | — |
| `monitor-classify-error.ts` (stdin) | Classifies a single log line into `crash`, `persistent-warning`, `transient`, or `unknown`. Writes JSON to stdout. | — |
| `monitor-dispatch-queue.ts --claim <files> --agent-id <id>` | Claims file-allowlist locks before dispatching a sub-agent. Returns `DISPATCH` or `BLOCK`. | `MONITOR_QUEUE_DIR` |
| `monitor-dispatch-queue.ts --release --agent-id <id>` | Releases locks held by a finished or cancelled agent. | `MONITOR_QUEUE_DIR` |
| `monitor-session-log.ts <event-type> [payload-json]` | Appends a structured event to the session log. Types: `triage`, `dispatch`, `heartbeat`, `verify`, `fix`, `flag-user`. | `MONITOR_SESSION_LOG` |
| `monitor-report.ts <session-log> [start-epoch]` | Reads the NDJSON log and prints a consolidated markdown report. | — |

The `Monitor` tool (SDK-level streaming) is used for log/process event streams. `TaskStop` kills a stale watcher. `Agent` (background) dispatches sub-agents. These are not shell scripts — they are Claude Code SDK primitives called by the skill itself.

### Side effects

- **Reversible local changes** — when the skill triages an error as `crash` or `persistent-warning` and the fix is local (code edit, dep install, cache clear, config reload), it dispatches a sub-agent that edits files, commits, and pushes. All commits follow `fix(scope):` or `perf(scope):` conventions and are pushed immediately per the always-commit-and-push rule.
- **Lock files** — `monitor-dispatch-queue.ts` creates `.lock` files under `MONITOR_QUEUE_DIR` while a sub-agent is in flight. These are released on `--release`; if an agent crashes, stale locks must be manually removed before re-dispatching.
- **Session log file** — `monitor-session-log.ts` appends to `MONITOR_SESSION_LOG` for the duration of the session. The file persists after the session ends and is the input for the final report.
- **No production / shared-state changes** — the skill never acts on production databases, shared infra, or destructive operations without explicit user confirmation in the current turn. These are flagged, not fixed.
- **No platform restarts** — per repo policy (`AGENTS.md`), the skill does not start stopped services. It prompts the user to start them instead.

### Mode toggles

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Stream every event** | Log file or long-running process | Use `Monitor` with `tail -F \| grep -E --line-buffered <pattern>` |
| **Wait for single completion** | "Tell me when the build finishes" | Use `Bash run_in_background: true` with `until` loop — not `Monitor` |
| **Re-arm with tighter filter** | `Monitor` reports `[N events suppressed]` | `TaskStop`, pipe suppressed lines through `monitor-suggest-filter.ts -`, re-arm |
| **Auto-fix** | Reversible local error | Dispatch sub-agent; verify before marking done |
| **Flag-for-user** | Shared-state or ambiguous error | Report evidence + options; wait for confirmation |

## Operational flow

```mermaid
flowchart TD
    A([User: monitor X]) --> B{Preconditions met?}
    B -- "target unclear / no source" --> C[Ask one clarifying question]
    B -- yes --> D[Arm Monitor watcher\ntail -F | grep -E pattern]
    D --> E{Event arrives?}
    E -- no event in ~20s --> F[Heartbeat: still quiet]
    F --> E
    E -- event --> G[Classify via\nmonitor-classify-error.ts]
    G --> H{Triage verdict}
    H -- transient --> I[Note + watch one cycle]
    I --> E
    H -- crash / blocking --> J{Reversible local fix?}
    H -- persistent-warning --> J
    J -- no / shared-state --> K[Flag for user\nwait for confirmation]
    K --> E
    J -- yes --> L[Claim file locks\nmonitor-dispatch-queue.ts --claim]
    L --> M[Dispatch sub-agent\nAgent background brief]
    M --> N[Sub-agent: edit → commit → push]
    N --> O[Verify, don't trust:\nstream clean? smoke test? SHA on remote?]
    O -- not verified --> P[Re-dispatch with corrected brief]
    P --> N
    O -- verified --> Q[Release locks\nmonitor-dispatch-queue.ts --release\nLog fix event]
    Q --> E
    E -- completion event / user stop --> R[monitor-report.ts\nEnd-of-session report]
    R --> S([Done])
```

## Layout

```
monitor/
├── README.md                  # This file
├── SKILL.md                   # Full operating loop, anti-patterns, tooling cheatsheet
├── agents/
│   └── openai.yaml            # Interface descriptor
├── assets/                    # Skill icons (generated)
├── references/
│   ├── script-inventory.md    # Full CLI signatures, flags, env vars, exit codes
│   ├── session-log-format.md  # NDJSON event schema
│   └── subagent-brief-template.md  # Copy-ready sub-agent brief template
├── scripts/
│   ├── monitor-suggest-filter.ts
│   ├── monitor-classify-error.ts
│   ├── monitor-dispatch-queue.ts
│   ├── monitor-report.ts
│   └── monitor-session-log.ts
├── script-inventory.md        # (root alias — same content as references/)
├── session-log-format.md
└── subagent-brief-template.md
```

## Quick start

```bash
# 1. Copy env template
cp .env.example .env
# Edit MONITOR_QUEUE_DIR or MONITOR_SESSION_LOG if needed.

# 2. (Optional) pre-generate a grep pattern from existing logs
npx tsx skills/monitor/scripts/monitor-suggest-filter.ts /path/to/log 500

# 3. In Claude Code, say:
#    "Monitor the ingestion log at /var/log/ingest.log and fix anything that breaks."
#    The skill arms, heartbeats, and dispatches sub-agents automatically.

# 4. Classify a noisy line manually
echo "ERROR connect ECONNREFUSED 127.0.0.1:3001" \
  | npx tsx skills/monitor/scripts/monitor-classify-error.ts

# 5. View the session report after the run
npx tsx skills/monitor/scripts/monitor-report.ts \
  .tmp/monitor-2026-05-16T14-00-00.ndjson
```

## Resources

- [`SKILL.md`](./SKILL.md) — full operating loop, anti-patterns, troubleshooting table, and companion skill patterns
- [`references/script-inventory.md`](./references/script-inventory.md) — complete CLI reference for all five scripts
- [`references/session-log-format.md`](./references/session-log-format.md) — NDJSON event schema
- [`references/subagent-brief-template.md`](./references/subagent-brief-template.md) — copy-ready sub-agent brief template
- [`agents/openai.yaml`](./agents/openai.yaml) — interface descriptor

## Caveats

- The skill is not a passive log viewer. It acts on events — heartbeats stop only when the watched operation ends or the user says so.
- Two sub-agents must not touch overlapping files in parallel; the dispatch queue enforces this via lock files. If a previous agent crashed and left stale locks, remove `.tmp/monitor-dispatch-queue/*.lock` manually.
- The `Monitor` tool suppresses events when output rate is too high. If you see `[N events suppressed]`, the grep filter is too loose — stop, retighten with `monitor-suggest-filter.ts`, and re-arm.
- GG-category skills are gitignored from the parent repo and maintained as standalone GitHub repositories. This skill follows the same pattern as `skills-manager`, `extractor`, and `claude-designer`.
