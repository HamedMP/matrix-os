# Quiet Codex command execution

Tracking: [ENG-344](https://linear.app/matrix-os/issue/ENG-344/investigate-unified-matrix-agent-runtime-approval-output-and-upload).

## Problem and scope

A background CI watcher can redirect both output streams to a file and remain
healthy while the agent performs other work. The Codex runner currently treats
30 minutes without command output as inactivity and interrupts the entire turn.
Terminal output is not a reliable liveness signal for a shell command.

## Change

Exclude `commandExecution` items from the output inactivity cutoff. Preserve
their existing explicit duration limit (`MATRIX_CODEX_COMMAND_DEADLINE_MS`, eight
hours by default), independently of output. Other item types retain their own
inactivity and execution limits. Other tools' progress cannot extend a stalled
connector's deadline.

Keep current Stop, approval/input wait accounting, timeout interruption and
cleanup behavior. Do not introduce automatic retries or replay uncertain work.
Command-local recovery and richer timeout UI are separate follow-ups.

This is a renderer-independent runner correction. Web Canvas, Web Desktop,
Electron Desktop, Web Mobile and Native Mobile use the same backend behavior;
no renderer, route, persisted schema, credential or authorization path changes.
No per-surface visual qualification is claimed. Recommend review by the runtime
owner; reviewer confirmation of the backend-only evidence scope remains explicit.

## Acceptance and validation

- A shell command survives beyond the former 30-minute inactivity boundary,
  with or without activity from other commands.
- A real subprocess writing only to a file completes through the production
  runner and transcript parser after the scaled inactivity interval.
- The command's explicit duration limit still expires, even with output.
- A stalled connector still expires despite other commands making progress;
  empty connector output does not count as progress.
- Existing Stop, human-wait, late-result fencing and cleanup regressions pass.

Show assertion-level regression red/green against the original watchdog.
Subprocess tests use a synthetic native provider and scaled timing limits; they
do not establish live-provider or device acceptance. Keep captures and logs
outside the repository. CI and Greptile qualify the exact PR head.

## Documentation

Update the developer runtime guidance in this PR. A separate documentation PR
in `FinnaAI/matrix-os-site` should explain quiet commands and retained operation
limits in the canonical public docs; track that companion explicitly rather
than treating local fixture results as public documentation or a deployment.
