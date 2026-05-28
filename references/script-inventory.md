# Script Inventory

Complete reference for the five TypeScript companion scripts in `scripts/`. All scripts are runnable via `npx tsx` from the repo root and write to stdout (logs go to stderr).

## monitor-suggest-filter.ts

Generates a `grep -E --line-buffered` pattern from the most frequent error tokens in a log sample.

```bash
npx tsx skills/monitor/scripts/monitor-suggest-filter.ts \
  /path/to/log 500
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `logfile` | yes | — | Path to log file, or `-` to read from stdin. |
| `sample-lines` | no | `500` | Number of tail lines to sample. |

**Environment:** none.

**Exit codes:** `0` (pattern emitted), `1` (missing argument).

**Example — re-tighten after suppression:**

```bash
cat /path/to/log | grep -v "NoisyKnownLine" \
  | npx tsx skills/monitor/scripts/monitor-suggest-filter.ts -
```

## monitor-classify-error.ts

Classifies a single log line into `crash`, `persistent-warning`, `transient`, or `unknown`.

```bash
echo "ERROR connect ECONNREFUSED 127.0.0.1:3001" \
  | npx tsx skills/monitor/scripts/monitor-classify-error.ts
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `line` | no (uses stdin) | — | The log line to classify. If omitted, reads from stdin. |

**Environment:** none.

**Exit codes:** `0` always. Writes JSON to stdout.

**Output shape:**

```json
{
  "cat": "persistent-warning",
  "reason": "infra-connectivity",
  "timestamp": "2026-05-02T14:33:01Z",
  "raw": "ERROR connect ECONNREFUSED ...",
  "nextAction": "flag-user-or-dispatch-with-constraints"
}
```

## monitor-dispatch-queue.ts

Claims or releases file-allowlist locks to prevent overlapping sub-agent dispatches.

```bash
# claim
npx tsx skills/monitor/scripts/monitor-dispatch-queue.ts \
  --claim "lib/db.ts,lib/cache.ts" --agent-id agent_42

# release
npx tsx skills/monitor/scripts/monitor-dispatch-queue.ts \
  --release --agent-id agent_42
```

| Flag | Required | Description |
|------|----------|-------------|
| `--claim` | for claim | Comma-separated file list. |
| `--release` | for release | Release all files held by this agent. |
| `--agent-id` | yes | Unique agent identifier. |

**Environment:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MONITOR_QUEUE_DIR` | `.tmp/monitor-dispatch-queue` | Directory for lock files. |

**Exit codes:** `0` (dispatch or release succeeded), `1` (BLOCK or bad args).

**Output shape:**

```json
{ "action": "DISPATCH", "agentId": "agent_42", "files": ["lib/db.ts", "lib/cache.ts"] }
{ "action": "BLOCK", "reason": "overlap", "file": "lib/db.ts", "heldBy": "agent_7" }
{ "action": "RELEASED", "agentId": "agent_42" }
```

## monitor-session-log.ts

Appends a structured NDJSON event to the durable session log.

```bash
npx tsx skills/monitor/scripts/monitor-session-log.ts \
  triage '{"class":"EADDRINUSE","verdict":"persistent-warn"}'
```

| Argument | Required | Description |
|----------|----------|-------------|
| `event-type` | yes | `triage`, `dispatch`, `heartbeat`, `verify`, `fix`, or `flag-user`. |
| `payload-json` | no | `{}` | Arbitrary JSON payload. |

**Environment:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MONITOR_SESSION_LOG` | `.tmp/monitor-<iso>.ndjson` | Log file path. |

**Exit codes:** `0` (logged), `1` (bad JSON or missing type).

## monitor-report.ts

Reads the session log and prints a consolidated markdown report.

```bash
npx tsx skills/monitor/scripts/monitor-report.ts \
  .tmp/monitor-2026-05-02T02-42-33.ndjson 1746184953
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `session-log` | yes | — | Path to the NDJSON log file. |
| `start-epoch` | no | `now` | Unix epoch (seconds) when monitoring began. |

**Environment:** none.

**Exit codes:** `0` (report printed), `1` (missing arg or unreadable file).
