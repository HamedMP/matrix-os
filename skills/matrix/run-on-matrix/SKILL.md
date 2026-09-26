---
name: run-on-matrix
description: Run coding work on a remote Matrix computer through its CLI or MCP, with persistent sessions, evidence-based supervision, parallel workers and independent review. Use when work should continue after the local laptop disconnects.
---

# Run on Matrix

Own the outcome after dispatch. A remote process starting is not evidence that implementation, testing or PR delivery happened. Preserve the user's scope, chosen agent/model, and authorization; remote execution does not authorize merging, deploying, buying resources or changing credentials.

## Establish the remote execution path

1. Discover available Matrix MCP session/command tools; otherwise use `matrix`. Inspect installed `--help` rather than inventing commands. Verify the selected profile/computer, remote repository, agent login, GitHub access and necessary runtime tools. Never print credentials or copy local authentication stores.
2. Prefer fetching the authorized repository/branch on Matrix. Use a new persistent manual git worktree; preserve existing worktrees and processes. Record repository, base SHA, branch and PR parent. If local changes must travel, transfer only reviewed task files and a concise brief. Raw transcripts require separate disclosure/approval; they are unnecessary for normal execution.
3. Check remote agent capabilities with its help output. Use its configured model unless the user selects another. Keep sandbox/approval review enabled; do not bypass restrictions to make unattended work convenient. A network denial inside an agent sandbox is not proof that credentials are invalid: verify the exact operation from the authorized outer execution path before diagnosing auth.
4. Put the brief, progress state and logs in a task-specific remote directory outside tracked source. Include the accepted goal, scope exclusions, constraints, source refs, known failures, ownership, test requirements, delivery criteria and next actions. Do not transfer unrelated conversation history.
5. Start a named persistent Matrix shell session, not a local terminal or SSH-dependent foreground job. Capture remote output, provider session ID and exit status. Verify repository/tool activity after startup; handle model/auth/startup errors before announcing that work is underway.

Supported CLI examples (verify flags on the installed version):

```sh
matrix status
matrix shell ls --json
matrix run --json -- sh -lc 'pwd; command -v codex; command -v gh'
matrix upload /local/task-brief.md projects/task-run/brief.md --json
matrix shell new task-worker --cwd projects/task-worktree --cmd 'bash /home/matrix/home/projects/task-run/worker.sh' --json
matrix shell attach task-worker
```

The example home path is not universal; resolve the actual remote home first. Construct scripts/structured arguments using safe quoting. Do not paste prompts into an unknown live terminal. For Codex, a wrapper can feed the brief to `codex exec --approve-for-me -`, tee output, preserve the exit code with `pipefail`, and save a final response. Check support before using those flags. Do not infer an app deep link from a session name; report links returned by the tool or verified routes.

Before saying the laptop can sleep, close the initiating CLI/MCP connection, reconnect, and verify worker/coordinator activity still advances and their artifacts are mutually accessible. Confirm a persistent remote coordinator owns offline transitions from implementation to review, fixes and PR publication. A read-only watcher alone cannot advance that workflow.

## Divide work where it actually helps

Create a small dependency graph before parallelizing. Start with a coordinator and at most two independent workers unless the user or resource budget supports more. Use separate worktrees and named sessions for remote workers so they survive laptop closure. Local subagents are useful for local review, but are not an offline execution guarantee.

Each assignment identifies owned files/modules, base commit, expected output, tests, dependencies and stop conditions. Tell workers they are not alone and must preserve others' edits. One writer owns each branch/module. Share contracts first when tasks depend on the same interface; avoid parallel edits to a central schema, lockfile or composition root. The coordinator handles shared changes and integration.

For stacked PRs, create each child from its actual parent and target that parent branch; independent fixes can target main. Track SHAs and dependency links. Coordinate upstream merges/rebases with owners so an updated parent does not invalidate workers' assumptions. Never force-push another active agent's branch or merge a parent merely to unblock a stack.

## Supervise with evidence

Keep a remote run record containing session/process identity, worktree/branch/parent, current phase, last observed substantive change, commit SHA, test command/results, PR links, assigned reviewers and blockers. Give each worker its own progress file; the coordinator owns the aggregate record. Use explicit states: `implementing`, `ready_for_review`, `changes_requested`, `ready_for_pr`, `blocked`, `complete`. Every handoff carries immutable base/head SHAs and artifact paths. Treat PR-ready as an existing correctly based PR, passed required checks, and resolved or explicitly recorded findings, not merely a worker exit.

Check shortly after startup, then ordinarily every 5–15 minutes. Compare actual git changes/commits, bounded logs, test outcomes and PR state with the previous observation. Distinguish:

- **Running:** recent substantive work or an identified ongoing test/build.
- **Waiting:** needs input, approval, rate-limit recovery or a dependency.
- **Suspected stall:** two observations without substantive progress; inspect process state and current command before concluding it is stuck.
- **Exited:** capture exit status and final output; zero exit alone does not establish completion.
- **Complete:** promised artifacts exist, relevant checks passed and review findings have dispositions.

Advance logs alone can be repeated failures, while quiet logs can be a healthy long test. Resolve routine dependency/setup issues within authorization. Send bounded, concrete follow-ups when the session supports them. Resume an exited agent with its exact session ID only after proving no writer remains active. Avoid duplicate agents, restart loops and blind retries of externally mutating operations. After repeated identical failure, preserve work and report the precise blocker.

Monitoring must itself have an owner and lifetime. For recurring checks requested in Codex, use the available heartbeat automation tool, deduplicating existing monitors. Do not substitute an ad-hoc local cron job. Explicitly state where the scheduler runs: local-app monitoring can pause when the laptop is asleep. For offline coverage, use an available Matrix-side scheduler/supervisor or a bounded remote watcher in its own persistent session; validate that it is detached and actually producing fresh observations. A read-only watcher detects problems; it does not equal an AI reviewer or automatically repair them.

Record notification delivery separately: use an available authorized destination and verify its mechanism. Writing a remote status file does not notify the user. If only a local heartbeat is available, explain that notifications may wait until that host resumes; remote results remain inspectable.

Choose a finite monitoring lifetime (for example 24 hours), record the expiry and stop/cancel command, and stop on completion/cancellation. Monitor expiry stops observation only unless explicitly configured otherwise. Record worker/coordinator time or cost limits separately, and capture status/preserve work on cancellation. Never silently promise perpetual monitoring or uninterrupted remote infrastructure. Do not automatically extend a spending/time budget. Report only meaningful milestones, new failures or required decisions unless the user asks for periodic updates.

## Have agents review each other

After a worker produces a coherent commit, assign another agent a read-only review of the exact base/head diff and relevant context. Enforce a read-only sandbox for reviewers accessing a live writer worktree (for example, verified `codex exec -s read-only` support), or give the reviewer a separate immutable-commit worktree. A prompt saying “read-only” alone is insufficient. Reviewers do not modify the author's worktree. Give risk-specific responsibilities when useful: one can check auth/concurrency/resource bounds and another can check UX/contracts/tests. A worker can review another worker's independent change after finishing its own assignment.

For independent fixes A and B, commit both before cross-review: B reviews A and A reviews B using immutable SHAs; each author fixes its own branch, then the other rechecks the revised SHA. The remote coordinator advances these states and handles bounded waits or blocked workers without leaving both agents waiting indefinitely.

Require findings to include severity, file/line, failure scenario and suggested verification; “looks good” is not test evidence. The author fixes findings and adds regression coverage where warranted. The reviewer rechecks the revised SHA. The coordinator validates integration and required repository/CI gates. Reviews never grant permission to deploy or merge, and simulated tests must not be described as device/provider validation.

## Finish or hand back truthfully

Report the remote session/attach command, current phase, concrete code/PR links, checks actually run, unresolved gates, monitoring location and expiry. If only startup is complete, say that. Keep useful progress artifacts remotely so a later session can resume without the laptop. Stop task-specific watchers after completion; preserve unfinished worktrees. Follow repository rules before cleaning up merged worktrees and never terminate unrelated sessions.
