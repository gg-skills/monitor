#!/usr/bin/env npx tsx

/**
 * Monitor Completeness Checker
 * 
 * Verifies a monitoring session against the 9-item Monitor Quality Checklist.
 * 
 * Usage:
 *   npx tsx skills/monitor/scripts/check-monitor-completeness.ts --phase <phase>
 */

import { argv } from "process";

// ============================================================================
// Types
// ============================================================================

/**
 * One row of the nine-item monitor quality checklist used for scoring.
 *
 * @remarks
 * PURITY: Describes static checklist metadata plus a per-run `checked` flag computed from `--phase`.
 */
interface ChecklistItem {
  number: number;
  name: string;
  description: string;
  required: boolean;
  checked: boolean;
  weight: number;
}

/**
 * Machine-readable snapshot emitted when `--json` is passed on the CLI.
 *
 * @remarks
 * I/O: Only serialized to stdout when `--json` is present; otherwise the script stays human-console only.
 */
interface CompletenessReport {
  checklist: ChecklistItem[];
  score: number;
  maxScore: number;
  canFinalize: boolean;
}

// ============================================================================
// Checklist Definition
// ============================================================================

const CHECKLIST_ITEMS: Omit<ChecklistItem, "checked">[] = [
  { number: 1, name: "Target named", description: "Concrete thing to monitor identified", required: true, weight: 2 },
  { number: 2, name: "Source identified", description: "Stable stream source confirmed", required: true, weight: 2 },
  { number: 3, name: "Success/failure criteria defined", description: "Know what outcomes look like", required: true, weight: 2 },
  { number: 4, name: "Heartbeat scheduled", description: "~20 second interval set", required: true, weight: 2 },
  { number: 5, name: "Error classification ready", description: "Three-state triage defined", required: true, weight: 1 },
  { number: 6, name: "Dispatch isolation set", description: "File locks for parallel agents", required: false, weight: 2 },
  { number: 7, name: "Fix verification planned", description: "Smoke tests ready for each fix type", required: true, weight: 2 },
  { number: 8, name: "Timeout/end condition set", description: "Explicit stop condition defined", required: true, weight: 1 },
  { number: 9, name: "Summary reported", description: "Events, fixes, outcomes documented", required: true, weight: 2 },
];

// ============================================================================
// Main
// ============================================================================

/**
 * CLI entrypoint that scores monitor readiness from `--phase` and prints results.
 *
 * @remarks
 * I/O: Reads `process.argv`; writes human-readable lines to stdout and optional JSON when `--json` is set.
 * USAGE: Supports `--phase`/`-p <1-9>` (defaults to 9 when omitted).
 */
function main() {
  const args = argv.slice(2);
  const phaseArg = args.find(a => a === "--phase" || a === "-p");
  const jsonArg = args.includes("--json");
  
  const currentPhase = phaseArg 
    ? parseInt(args[args.indexOf(phaseArg) + 1] || "9", 10)
    : 9;
  
  console.log("\n📋 Monitor Completeness Check");
  console.log("═".repeat(60));
  console.log(`\n📊 Current Phase: ${currentPhase}/9`);
  
  // Build checklist based on current phase
  const checklist: ChecklistItem[] = CHECKLIST_ITEMS.map(item => {
    let checked = false;
    
    // Pre-start phases (1-3)
    const preStartDone = currentPhase >= 1;
    // Active phases (4-7)
    const activeDone = currentPhase >= 4;
    // Closeout phase (8-9)
    const closeoutDone = currentPhase >= 8;
    
    switch (item.number) {
      case 1: // Target named
        checked = preStartDone;
        break;
      case 2: // Source identified
        checked = preStartDone;
        break;
      case 3: // Success/failure criteria defined
        checked = preStartDone;
        break;
      case 4: // Heartbeat scheduled
        checked = activeDone;
        break;
      case 5: // Error classification ready
        checked = activeDone;
        break;
      case 6: // Dispatch isolation set
        checked = activeDone || item.required === false;
        break;
      case 7: // Fix verification planned
        checked = activeDone;
        break;
      case 8: // Timeout/end condition set
        checked = closeoutDone;
        break;
      case 9: // Summary reported
        checked = currentPhase >= 9;
        break;
      default:
        break;
    }
    
    return { ...item, checked };
  });
  
  const score = checklist.reduce((sum, item) => 
    item.checked ? sum + item.weight : sum, 0);
  const maxScore = checklist.reduce((sum, item) => sum + item.weight, 0);
  
  const requiredItems = checklist.filter(i => i.required);
  const requiredScore = requiredItems.reduce((sum, item) => 
    item.checked ? sum + item.weight : sum, 0);
  const requiredMax = requiredItems.reduce((sum, item) => sum + item.weight, 0);
  
  const canFinalize = requiredScore === requiredMax;
  
  console.log(`\n📊 Score: ${score}/${maxScore} (${((score/maxScore)*100).toFixed(0)}%)`);
  console.log(`   Required items: ${requiredScore}/${requiredMax}`);
  
  console.log(`\n${canFinalize ? "✅" : "⚠️"} Ready to start/close: ${canFinalize ? "YES" : "NEEDS WORK"}`);
  
  console.log("\n📝 Checklist:");
  for (const item of checklist) {
    const icon = item.checked ? "✅" : item.required ? "❌" : "⚠️";
    console.log(`   ${icon} [${item.number}] ${item.name}`);
  }
  
  console.log("\n" + "═".repeat(60));
  
  if (!canFinalize) {
    console.log("\n⚠️ Monitoring session needs work.");
    const failedItems = checklist.filter(i => !i.checked && i.required);
    if (failedItems.length > 0) {
      console.log("\nIssues to resolve:");
      failedItems.forEach(i => console.log(`   - ${i.name}: ${i.description}`));
    }
  } else {
    console.log("\n✅ Ready for monitoring session.");
  }
  
  if (jsonArg) {
    const report: CompletenessReport = { checklist, score, maxScore, canFinalize };
    console.log("\n" + JSON.stringify(report, null, 2));
  }
}

main();
