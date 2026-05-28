#!/usr/bin/env -S npx tsx
/**
 * @fileoverview Parses a single log line and classifies it into one of four
 * triage categories, emitting structured JSON with a recommended next action.
 * Companion script for the monitor skill Step 4 (triage).
 *
 * Runtime: accepts a line via argument or stdin; writes JSON to stdout.
 * Verification: feed known error lines and assert the emitted category.
 */

/**
 * Triage bucket for a single log line used by monitor Step 4 routing.
 *
 * @remarks
 * Values are stable wire tokens for JSON output; extend RULES alongside new literals.
 */
type Verdict = "crash" | "persistent-warning" | "transient" | "unknown";

/**
 * Structured classification emitted to stdout for agents and humans.
 *
 * @remarks
 * `nextAction` is a routing hint, not an executable command.
 */
interface Classification {
  cat: Verdict;
  reason: string;
  timestamp: string;
  raw: string;
  nextAction: string;
}

/**
 * Options for {@link classify}.
 *
 * @remarks
 * Callers must pass the full raw log line; leading timestamps are parsed opportunistically.
 */
interface MonitorClassifyError_Classify_Options {
  line: string;
}

const RULES: Array<{
  cat: Verdict;
  reason: string;
  pattern: RegExp;
  nextAction: string;
}> = [
  {
    cat: "crash",
    reason: "process-death-signal",
    pattern: /fatal|panic|crash|killed|oom|traceback/i,
    nextAction: "dispatch-subagent-if-reversible",
  },
  {
    cat: "persistent-warning",
    reason: "infra-connectivity",
    pattern: /econnrefused|eaddrinuse|ENOTFOUND|mongoerror/i,
    nextAction: "flag-user-or-dispatch-with-constraints",
  },
  {
    cat: "transient",
    reason: "mid-restart-noise",
    pattern: /econnreset|rst_stream|aborted/i,
    nextAction: "watch-one-cycle-then-move-on",
  },
  {
    cat: "persistent-warning",
    reason: "slow-error-path",
    pattern: /5[0-9][0-9].*\d{4,}ms|slow db write|timeout/i,
    nextAction: "flag-user-or-dispatch-with-constraints",
  },
  {
    cat: "crash",
    reason: "fast-502-upstream-dead",
    pattern: /5[0-9][0-9].*\d{1,3}ms/i,
    nextAction: "dispatch-subagent-if-reversible",
  },
];

/**
 * Applies ordered regex rules to map one log line to a triage verdict and next action.
 *
 * @remarks
 * PURITY: no I/O; first matching RULES entry wins, otherwise `unknown`.
 */
function classify(
  options: MonitorClassifyError_Classify_Options,
): Classification {
  const { line } = options;
  const timestamp = line.match(/^[0-9\-T:.Z]+/)?.[0] ?? "unknown";

  for (const rule of RULES) {
    if (rule.pattern.test(line)) {
      return {
        cat: rule.cat,
        reason: rule.reason,
        timestamp,
        raw: line,
        nextAction: rule.nextAction,
      };
    }
  }

  return {
    cat: "unknown",
    reason: "needs-manual-review",
    timestamp,
    raw: line,
    nextAction: "flag-user",
  };
}

/**
 * CLI entry: reads one line from argv or stdin and prints pretty JSON classification.
 *
 * @remarks
 * I/O: writes UTF-8 JSON to stdout; stdin path buffers until `end` before classifying.
 */
function main(): void {
  const fromStdin = process.argv.length <= 2;
  if (fromStdin) {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => {
      const line = buffer.trimEnd();
      console.log(JSON.stringify(classify({ line }), null, 2));
    });
  } else {
    const line = process.argv.slice(2).join(" ");
    console.log(JSON.stringify(classify({ line }), null, 2));
  }
}

main();
