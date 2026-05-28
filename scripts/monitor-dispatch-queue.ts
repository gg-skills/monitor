#!/usr/bin/env -S npx tsx
/**
 * @fileoverview Prevents parallel sub-agent dispatches from touching
 * overlapping files, eliminating push-conflict messes mid-session. Companion
 * script for the monitor skill Step 6 (dispatch).
 *
 * Runtime: invoked via npx tsx from repo root; claims or releases file locks
 * via atomic mkdir. Returns JSON with action DISPATCH, BLOCK, or RELEASED.
 * Verification: claim a file, claim it again from a different agent-id and
 * assert BLOCK is returned, then release and assert DISPATCH succeeds.
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const QUEUE_DIR =
  process.env.MONITOR_QUEUE_DIR || ".tmp/monitor-dispatch-queue";

/**
 * Wire-level outcome of a claim or release against the dispatch queue.
 *
 * @remarks
 * Stable JSON contract for callers; values align with script stdout and exit codes (BLOCK → 1).
 */
type DispatchAction = "DISPATCH" | "BLOCK" | "RELEASED";

/**
 * JSON payload emitted for claim and release operations.
 *
 * @remarks
 * On BLOCK, `file` and `heldBy` identify the first conflicting path and lock owner when readable.
 */
interface MonitorDispatchQueue_ClaimResult {
  action: DispatchAction;
  agentId?: string;
  files?: string[];
  reason?: string;
  file?: string;
  heldBy?: string;
}

/**
 * Options for attempting a single non-recursive directory create as a lock primitive.
 */
interface MonitorDispatchQueue_MkdirAtomically_Options {
  dir: string;
}

/**
 * Attempts a non-recursive mkdir to acquire an exclusive lock directory.
 *
 * @remarks
 * I/O: synchronous `mkdirSync`. Returns false when the path already exists or mkdir fails.
 */
function mkdirAtomically(
  options: MonitorDispatchQueue_MkdirAtomically_Options,
): boolean {
  try {
    mkdirSync(options.dir, { recursive: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalized CLI arguments after scanning `process.argv`.
 */
interface MonitorDispatchQueue_ParseArgs_Return {
  action: "claim" | "release" | null;
  agentId: string | null;
  claim: string | null;
}

/**
 * Parses argv for claim/release mode, agent id, and optional comma-separated claim list.
 *
 * @remarks
 * Does not validate shapes beyond positional pairing with flags; callers enforce required fields.
 */
function parseArgs(): MonitorDispatchQueue_ParseArgs_Return {
  const args = process.argv.slice(2);
  const claimIdx = args.indexOf("--claim");
  const releaseIdx = args.indexOf("--release");
  const aidIdx = args.indexOf("--agent-id");

  const action = claimIdx >= 0 ? "claim" : releaseIdx >= 0 ? "release" : null;
  const agentId = aidIdx >= 0 ? args[aidIdx + 1] : null;
  const claim = claimIdx >= 0 ? args[claimIdx + 1] : null;

  return { action, agentId, claim };
}

/**
 * Inputs for acquiring per-file lock directories and recording the agent's claim manifest.
 */
interface MonitorDispatchQueue_ClaimFiles_Options {
  agentId: string;
  claim: string;
}

/**
 * Claims exclusive locks for a comma-separated path list for the given agent.
 *
 * @remarks
 * I/O: creates queue dir, per-file `.lock` dirs with `owner` files, and `${agentId}.claim`.
 * On overlap, returns BLOCK; any earlier paths in the iteration may already hold locks for this
 * agent until a matching `release` runs.
 */
function claimFiles(
  options: MonitorDispatchQueue_ClaimFiles_Options,
): MonitorDispatchQueue_ClaimResult {
  mkdirSync(QUEUE_DIR, { recursive: true });
  const files = options.claim
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  for (const f of files) {
    const safe = f.replace(/\//g, "_");
    const lockPath = join(QUEUE_DIR, `${safe}.lock`);

    if (!mkdirAtomically({ dir: lockPath })) {
      let heldBy = "unknown";
      try {
        heldBy = readFileSync(join(lockPath, "owner"), "utf8").trim();
      } catch {
        /* ignore */
      }
      return { action: "BLOCK", reason: "overlap", file: f, heldBy };
    }

    writeFileSync(join(lockPath, "owner"), options.agentId);
  }

  writeFileSync(join(QUEUE_DIR, `${options.agentId}.claim`), options.claim);
  return { action: "DISPATCH", agentId: options.agentId, files };
}

/**
 * Inputs for releasing locks previously recorded under an agent id.
 */
interface MonitorDispatchQueue_ReleaseFiles_Options {
  agentId: string;
}

/**
 * Removes lock directories and the agent claim file when present.
 *
 * @remarks
 * I/O: synchronous reads and recursive deletes under `QUEUE_DIR`. Idempotent when no claim exists.
 */
function releaseFiles(
  options: MonitorDispatchQueue_ReleaseFiles_Options,
): MonitorDispatchQueue_ClaimResult {
  const claimFile = join(QUEUE_DIR, `${options.agentId}.claim`);
  if (existsSync(claimFile)) {
    const claim = readFileSync(claimFile, "utf8").trim();
    const files = claim
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    for (const f of files) {
      const safe = f.replace(/\//g, "_");
      rmSync(join(QUEUE_DIR, `${safe}.lock`), { recursive: true, force: true });
    }
    rmSync(claimFile, { force: true });
  }
  return { action: "RELEASED", agentId: options.agentId };
}

/**
 * CLI entry: parses flags, dispatches claim or release, prints JSON, exits non-zero on usage or BLOCK.
 *
 * @remarks
 * Writes diagnostics to stderr and result JSON to stdout; process exit codes encode hard failures.
 */
function main(): void {
  const { action, agentId, claim } = parseArgs();

  if (!action || !agentId) {
    console.error(
      "Usage: --claim 'a.ts,b.ts' --agent-id <id>  OR  --release --agent-id <id>",
    );
    process.exit(1);
  }

  if (action === "claim") {
    if (!claim) {
      console.error("--claim requires a comma-separated file list");
      process.exit(1);
    }
    const result = claimFiles({ agentId, claim });
    console.log(JSON.stringify(result));
    if (result.action === "BLOCK") process.exit(1);
  } else {
    const result = releaseFiles({ agentId });
    console.log(JSON.stringify(result));
  }
}

main();
