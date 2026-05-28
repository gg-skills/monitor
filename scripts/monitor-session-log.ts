#!/usr/bin/env -S npx tsx
/**
 * @fileoverview Appends structured NDJSON events to a durable session log so
 * that long monitoring sessions do not rely on model memory for end-of-session
 * reporting. Companion script for the monitor skill Steps 3 and 9.
 *
 * Runtime: invoked via npx tsx from repo root; accepts event type and JSON
 * payload. Appends to $MONITOR_SESSION_LOG or auto-generates a timestamped
 * file under .tmp/.
 * Verification: inspect the generated NDJSON file after logging a few events.
 */

import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

/**
 * Wrapper for the chosen monitor-session NDJSON log path so callers share one stable shape.
 *
 * @remarks
 * `logFile` is the append target for structured session events; directory creation is left to the caller.
 */
interface MonitorSessionLog_GetLogFile_Return {
  logFile: string;
}

/**
 * Chooses the NDJSON log path from `MONITOR_SESSION_LOG` or a timestamped file under `.tmp/`.
 *
 * @remarks
 * Does not touch the filesystem; when the env var is unset, the derived filename reduces accidental cross-session reuse.
 */
function getLogFile(): MonitorSessionLog_GetLogFile_Return {
  const logFile =
    process.env.MONITOR_SESSION_LOG ??
    join(
      ".tmp",
      `monitor-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.ndjson`,
    );
  return { logFile };
}

/**
 * Parses CLI args, validates JSON payload, appends one NDJSON record, prints a confirmation object.
 *
 * @remarks
 * I/O: synchronous mkdir for parent dirs plus append. Exits with code 1 on missing event type or invalid JSON payload.
 */
function main(): void {
  const eventType = process.argv[2];
  const payloadRaw = process.argv.slice(3).join(" ") || "{}";

  if (!eventType) {
    console.error("Usage: monitor-session-log <event-type> [payload-json]");
    console.error(
      "  event-type: triage | dispatch | heartbeat | verify | fix | flag-user",
    );
    process.exit(1);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Invalid JSON payload:", payloadRaw, message);
    process.exit(1);
  }

  const { logFile } = getLogFile();
  mkdirSync(dirname(logFile), { recursive: true });

  const entry = {
    ts: new Date().toISOString(),
    type: eventType,
    payload,
  };

  appendFileSync(logFile, JSON.stringify(entry) + "\n");
  console.log(JSON.stringify({ logged: true, file: logFile, type: eventType }));
}

main();
