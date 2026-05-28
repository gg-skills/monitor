# Sub-Agent Brief Template

Copy this template and fill every field before dispatching a background sub-agent during a monitoring session.

```markdown
## Error Observed

- **Timestamp:** <paste exact timestamp from log>
- **Error string:** <paste verbatim log line>
- **Classification:** <crash | persistent-warning | transient | unknown>

## Context

- **Repo root:** <absolute or relative path>
- **Submodules affected:** <list if any>
- **AGENTS.md files to read:** <list paths from repo root to target folder>
- **Suspected call sites:** <file:line for each>

## Ruled Out

1. <what you already checked and found negative>
2. <what the error is NOT>

## Success Criteria

- <test command to run>
- <log line that should disappear>
- <metric that should change>

## Constraints — DO NOT TOUCH

- <adjacent code that would explode the diff>
- <workspace drift to ignore>
- <do not run npm run local / do not restart platform>

## Standing Rules

- Commit format: `fix(scope): description` or `perf(scope): description`
- Sign-off footer required
- Always commit and push after the fix
- Strict TypeScript: no `any`, no `eslint-disable`

## Self-Verification

Before reporting back, run:

```bash
<tsc --noEmit or targeted test command>
```

## Reporting Contract

Report back under 80 words:
- file:line changed
- commit SHA
- related call sites you also fixed (or noticed but left alone, with reason)
- tests run + result
```

## One-at-a-time rule

Before dispatching, claim file locks:

```bash
npx tsx skills/monitor/scripts/monitor-dispatch-queue.ts \
  --claim "<file1>,<file2>" --agent-id <unique-id>
```

Release after the agent verifies and reports back:

```bash
npx tsx skills/monitor/scripts/monitor-dispatch-queue.ts \
  --release --agent-id <unique-id>
```
