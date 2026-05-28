# Session Log Format

The `monitor-session-log.ts` script appends one line of NDJSON per event. The `monitor-report.ts` script consumes this log to produce the end-of-session report.

## Line schema

Every line is a single JSON object with no nested newlines:

```json
{
  "ts": "2026-05-02T14:33:01.123Z",
  "type": "triage",
  "payload": {}
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ts` | ISO-8601 string | Event timestamp in UTC. |
| `type` | enum string | Event category. |
| `payload` | object | Event-specific data. |

## Event types

### `heartbeat`

Emitted every ~20 seconds when nothing actionable has occurred.

```json
{
  "ts": "2026-05-02T14:33:01.123Z",
  "type": "heartbeat",
  "payload": { "status": "waiting", "note": "build still running" }
}
```

### `triage`

Emitted when a new error class is classified.

```json
{
  "ts": "2026-05-02T14:33:01.123Z",
  "type": "triage",
  "payload": {
    "class": "EADDRINUSE",
    "verdict": "persistent-warn",
    "reason": "infra-connectivity",
    "line": "ERROR connect EADDRINUSE 127.0.0.1:3001"
  }
}
```

Valid `verdict` values: `crash`, `persistent-warn`, `transient`, `flagged-user`.

### `dispatch`

Emitted when a sub-agent is dispatched.

```json
{
  "ts": "2026-05-02T14:33:01.123Z",
  "type": "dispatch",
  "payload": {
    "agent": "agent_42",
    "files": ["lib/db.ts"],
    "brief": "fix EADDRINUSE by switching to ephemeral port"
  }
}
```

Add `verified: true` and `commit: "abc1234"` when the fix is later confirmed.

### `fix`

Emitted for autonomous fixes applied directly by the monitor (not via sub-agent).

```json
{
  "ts": "2026-05-02T14:33:01.123Z",
  "type": "fix",
  "payload": {
    "actor": "monitor",
    "desc": "cleared stale .next cache",
    "sha": "def5678"
  }
}
```

### `verify`

Emitted after independent verification of a fix.

```json
{
  "ts": "2026-05-02T14:33:01.123Z",
  "type": "verify",
  "payload": {
    "class": "EADDRINUSE",
    "method": "curl health",
    "result": "pass"
  }
}
```

### `flag-user`

Emitted when an issue is escalated to the user instead of being fixed autonomously.

```json
{
  "ts": "2026-05-02T14:33:01.123Z",
  "type": "flag-user",
  "payload": {
    "class": "MongoError",
    "proposedAction": "restart replica set primary",
    "reason": "shared-state change"
  }
}
```

## File location

Default: `.tmp/monitor-<ISO-date>.ndjson`

Override with the `MONITOR_SESSION_LOG` environment variable.
