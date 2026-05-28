#!/usr/bin/env -S npx tsx
/**
 * @fileoverview Samples the tail of a log file, extracts high-signal error
 * tokens by frequency, and emits a ready-to-use grep -E pattern. Companion
 * script for the monitor skill Step 1 (arm watcher).
 *
 * Runtime: invoked via npx tsx from repo root; accepts a log path and optional
 * sample size. Writes the pattern to stdout and logs to stderr.
 * Verification: pipe a known log through it and inspect the emitted tokens.
 */

import { createInterface } from "readline";
import { spawn } from "child_process";

const TOKEN_RE =
  /([A-Z][a-z]+){2,}Error|FATAL|ERROR|panic|crash|Killed|OOM|[45][0-9][0-9]/gi;
const DEFAULT_SAMPLE = 500;
const TOP_N = 12;

/**
 * Options for sampling the tail of a log file via a `tail` subprocess.
 *
 * @remarks
 * I/O: `logfile` must be a readable path on the host filesystem; `n` is forwarded to `tail -n`.
 */
interface GgMonitorSuggestFilter_SampleViaTail_Options {
  logfile: string;
  n: number;
}

/**
 * Reads the last `n` lines from `logfile` by spawning `tail`.
 *
 * @remarks
 * I/O: spawns `tail`, forwards `tail` stderr to `process.stderr`, and resolves when the stdout
 * line reader closes. Child spawn errors reject the promise; partial reads still resolve on close.
 */
async function sampleViaTail(
  options: GgMonitorSuggestFilter_SampleViaTail_Options,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("tail", ["-n", String(options.n), options.logfile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => lines.push(line));
    rl.on("close", () => resolve(lines));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", reject);
  });
}

/**
 * Collects complete lines from stdin until EOF.
 *
 * @remarks
 * I/O: binds `readline` to `process.stdin`; used when the CLI argument is `-` (pipe mode).
 */
function sampleViaStdin(): Promise<string[]> {
  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  rl.on("line", (line) => lines.push(line));
  return new Promise((resolve) => {
    rl.on("close", () => resolve(lines));
  });
}

/**
 * Inputs for emitting a single-line `grep -E --line-buffered` suggestion.
 *
 * @remarks
 * Tokens are treated as alternation branches; callers are responsible for ranking and capping.
 */
interface GgMonitorSuggestFilter_BuildPattern_Options {
  tokens: string[];
}

/**
 * Builds a ready-to-paste `grep -E --line-buffered` command string from tokens.
 *
 * @remarks
 * Escapes regex metacharacters per-token and deduplicates while preserving first-seen order.
 */
function buildPattern(
  options: GgMonitorSuggestFilter_BuildPattern_Options,
): string {
  const escaped = options.tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter((t, i, arr) => arr.indexOf(t) === i);
  return `grep -E --line-buffered "${escaped.join("|")}"`;
}

/**
 * CLI entrypoint: samples log lines, ranks high-signal tokens, prints a grep pattern.
 *
 * @remarks
 * I/O: reads `process.argv` and stdin when `-`; writes usage to stderr when args are missing;
 * prints the pattern to stdout; exits 0 with a fallback pattern when no tokens match; exits 1 on
 * fatal errors. Mirrors `tail` stderr when sampling a file path.
 */
async function main(): Promise<void> {
  const rawArg = process.argv[2];
  const sampleSize = parseInt(process.argv[3] || String(DEFAULT_SAMPLE), 10);

  if (!rawArg) {
    console.error("Usage: monitor-suggest-filter <logfile> [sample-lines]");
    console.error("       cat lines.txt | monitor-suggest-filter -");
    process.exit(1);
  }

  const lines =
    rawArg === "-"
      ? await sampleViaStdin()
      : await sampleViaTail({ logfile: rawArg, n: sampleSize });

  const freq = new Map<string, number>();
  for (const line of lines) {
    const matches = line.matchAll(TOKEN_RE);
    for (const m of matches) {
      const tok = m[0];
      freq.set(tok, (freq.get(tok) || 0) + 1);
    }
  }

  const top = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([k]) => k);

  if (top.length === 0) {
    console.error("// No high-signal tokens found in sample.");
    console.log('grep -E --line-buffered "ERROR|FATAL|exception"');
    process.exit(0);
  }

  console.log(buildPattern({ tokens: top }));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
