#!/usr/bin/env -S npx tsx
/**
 * @fileoverview Reads a monitor-session-log NDJSON file and produces the
 * consolidated end-of-session report with wall-time, auto-categorized buckets,
 * and commit links. Companion script for the monitor skill Step 9.
 *
 * Runtime: invoked via npx tsx from repo root; accepts the session log path
 * and optional start epoch. Writes markdown to stdout.
 * Verification: pipe a known NDJSON log through it and inspect the report.
 */

import { readFileSync } from "fs";

/**
 * Parsed monitor-session NDJSON line contract used while grouping events by `type`.
 *
 * @remarks
 * Values originate from `JSON.parse` on each non-empty line; fields beyond this shape are ignored by callers.
 */
interface LogEntry {
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * CLI entrypoint: load the session log, aggregate entries, and print the markdown report on stdout.
 *
 * @remarks
 * Reads argv positions 2–3 (session path, optional start epoch); exits non-zero on missing path or unreadable file.
 */
function main(): void {
  const sessionLog = process.argv[2];
  const startEpoch = parseInt(
    process.argv[3] || String(Math.floor(Date.now() / 1000)),
    10,
  );

  if (!sessionLog) {
    console.error("Usage: monitor-report <session-log.ndjson> [start-epoch]");
    process.exit(1);
  }

  let raw: string;
  try {
    raw = readFileSync(sessionLog, "utf8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read session log: ${message}`);
    process.exit(1);
  }

  const lines: LogEntry[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      lines.push(JSON.parse(line) as LogEntry);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Skipping malformed line: ${message}`);
    }
  }

  const byType = lines.reduce<Record<string, LogEntry[]>>((acc, cur) => {
    acc[cur.type] = acc[cur.type] || [];
    acc[cur.type].push(cur);
    return acc;
  }, {});

  const duration = Math.floor(Date.now() / 1000 - startEpoch);

  /**
   * Returns entries for a log `type`, optionally narrowed by a predicate.
   *
   * @remarks
   * Uses the pre-grouped `byType` map; unknown types yield an empty array.
   */
  const pick = (
    type: string,
    filter?: (e: LogEntry) => boolean,
  ): LogEntry[] => {
    const arr = byType[type] || [];
    return filter ? arr.filter(filter) : arr;
  };

  const fixes = pick("fix").map(
    (e) =>
      `- ${String(e.payload.sha)} — ${String(e.payload.actor)}: ${String(e.payload.desc)}`,
  );

  const agentFixes = pick("dispatch", (e) => e.payload.verified === true).map(
    (e) => `- ${String(e.payload.commit)} via ${String(e.payload.agent)}`,
  );

  const observed = pick("triage", (e) => e.payload.verdict === "transient").map(
    (e) => `- ${String(e.payload.class)}: ${String(e.payload.reason)}`,
  );

  const awaiting = pick(
    "triage",
    (e) => e.payload.verdict === "flagged-user",
  ).map(
    (e) => `- ${String(e.payload.class)}: ${String(e.payload.proposedAction)}`,
  );

  console.log(`## Monitor Session Report
**Duration:** ${duration}s

### Fixes Applied
${fixes.join("\n") || "- none"}

### Sub-Agent Fixes
${agentFixes.join("\n") || "- none"}

### Observed, Not Touched
${observed.join("\n") || "- none"}

### Awaiting User
${awaiting.join("\n") || "- none"}
`);
}

main();
