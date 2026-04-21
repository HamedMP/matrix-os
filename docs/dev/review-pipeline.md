# Review Pipeline

How code gets reviewed in Matrix OS. Derived from the PR #30 post-mortem (154 inline comments, ~12 root-cause classes).

## The Problem This Solves

PR #30 received 167 review submissions that found overlapping subsets of the same ~12 root-cause classes. More reviews didn't help — structured passes do.

The fix is not "review harder." It's: **review a frozen, smaller PR with three explicit passes: mechanical gates, trust-boundary sweep, and atomicity/failure-mode review.**

## Pipeline Stages

```
PR opens
  |
  +-- CI Gate 1: typecheck + pattern scan    --> catches build errors, CLAUDE.md violations
  |
  +-- CI Gate 2: unit tests + e2e            --> catches correctness regressions
  |
  +-- AI Review: three-pass structured review --> catches trust-boundary + atomicity issues
  |
  +-- AI Security Review: focused security    --> catches auth/traversal/container issues
  |
  +-- Human Review (if needed)                --> architecture, design, product decisions
```

### What Each Stage Catches

| Stage | Category | Example from PR #30 |
|-------|----------|---------------------|
| **typecheck** | Missing imports, type mismatches, missing fields | Missing `stat` import, `R2ClientConfig` wrong fields, presign `size` field. *Note: runs as warning (`continue-on-error`) until baseline type errors are fixed.* |
| **pattern scan** | CLAUDE.md mechanical violations | Bare catch blocks, fetch without signal, writeFileSync, unbounded Maps |
| **unit tests** | Correctness regressions | Deleted files resurrected, schema inconsistencies |
| **AI review pass 1** | Remaining mechanical issues the scanner can't catch | Non-atomic file writes, bodyLimit gaps, shutdown cleanup |
| **AI review pass 2** | Trust-boundary violations | Path traversal, unvalidated headers, error leaking, share authz gaps |
| **AI review pass 3** | Atomicity and failure modes | Advisory lock bugs, DB/R2 split-brain, partial failure orphans |
| **AI security review** | Auth boundaries, container isolation | Internal routes without auth, secret forwarding, timing leaks |

## Running Locally

Before opening a PR:

```bash
# Gate 1: mechanical checks
bun run typecheck                     # tsc --noEmit for all packages
bun run check:patterns:diff           # CLAUDE.md pattern scanner (changed files only)

# Gate 2: tests
bun run test                          # unit tests
bun run test:e2e                      # e2e tests

# Full scan (useful for baseline audits, noisy on large codebases)
bun run check:patterns                # all files in packages/ and shell/
```

## PR Size Guidelines

| Additions | Files | Recommendation |
|-----------|-------|----------------|
| < 1000 | < 20 | Single PR, standard review |
| 1000-3000 | 20-50 | Single PR, request structured review |
| > 3000 | > 50 | **Split the PR** |

Suggested split boundaries for Matrix OS:
- **gateway** routes + middleware (one PR)
- **platform** auth + orchestrator (one PR)
- **sync-client** daemon + CLI (one PR)
- **shell** frontend changes (one PR)
- **docs + deploy** configuration (one PR)

## PR Body: Mandatory Invariants Section

Every PR touching backend code must include an invariants section:

```markdown
## Invariants

### Source of truth
- [What is the canonical data store for each entity?]
- [If two stores exist, what reconciles divergence?]

### Lock/transaction scope
- [What operations are inside the critical section?]
- [Are network calls (R2, external APIs) inside or outside the lock?]

### Acceptable orphan states
- [If step N fails after step N-1 succeeds, what is the resulting state?]
- [Is there cleanup/GC for orphaned objects?]

### Auth source of truth
- [Which auth mechanism is primary? (JWT, bearer, HMAC)]
- [What is the fallback behavior on auth failure?]

### Deferred scope
- [What is explicitly NOT in scope? (e.g., "share authz not wired yet")]
```

## Branch Freeze Rule

No deep review until the author either:
1. Declares a **review commit range** that won't move (e.g., "review `abc123..def456`"), or
2. Marks the PR as **ready for review** and stops pushing.

Reviewing a moving target guarantees second-order regressions — the PR #30 post-mortem showed later fix-wave commits introducing new issues that weren't in the original diff.

## The Review Passes

### Pass 1: Mechanical CLAUDE.md Sweep

Run these `rg` commands on changed files. Each maps to a mandatory pattern:

```bash
# Error handling: bare/empty catch
rg -n 'catch\s*\{' packages --glob '*.ts' --glob '!*.test.ts'
rg -n '\.catch\(\s*\(\s*\)\s*=>' packages --glob '*.ts' --glob '!*.test.ts'

# External calls: fetch without timeout
rg -n 'fetch\(' packages shell --glob '*.ts' --glob '!*.test.ts'

# Input validation: body consumption (verify bodyLimit present)
rg -n 'c\.req\.(json|text|blob|arrayBuffer)\(' packages --glob '*.ts'

# Resource management: unbounded structures
rg -n 'new Map|new Set|buffer +=' packages --glob '*.ts' --glob '!*.test.ts'

# Trust boundaries: path operations + external identifiers
rg -n 'join\(|resolve\(|realpath\(|rename\(|unlink\(' packages --glob '*.ts' --glob '!*.test.ts'
rg -n 'X-Forwarded-For|X-Peer-Id|peerId' packages --glob '*.ts' -i
```

The CI pattern scanner (`scripts/review/check-patterns.sh`) automates these. Reviewers only need to verify the scanner's warnings manually.

### Pass 2: Trust-Boundary Sweep

For each changed file, classify it and apply the matching checklist:

**Route handler files** (`routes.ts`, `server.ts`, `auth-routes.ts`):
- [ ] Every path/query/header param validated before use
- [ ] Error responses don't leak internals (no `err.message`, no Zod `.issues`)
- [ ] Auth middleware applied — check mounting order in parent
- [ ] bodyLimit on every mutating endpoint
- [ ] Rate limiter keyed on trusted IP source

**Filesystem files** (`home-mirror.ts`, `settings.ts`, file ops):
- [ ] All paths through `resolveWithinPrefix` or equivalent
- [ ] Symlink checks (`lstat` + `isSymbolicLink()`) before write/delete
- [ ] No `path.join()` on unvalidated external input
- [ ] Atomic writes (temp file + rename) for all non-test code
- [ ] File size checks before buffering into memory

**Database files** (`db-impl.ts`, `sharing.ts`, `device-flow.ts`):
- [ ] 2+ related writes in a transaction
- [ ] No TOCTOU (read → check → write without lock)
- [ ] `ON CONFLICT` for idempotent upserts
- [ ] Advisory lock scope matches the operations it protects

**WebSocket/IPC files** (`ws-events.ts`, `ws-client.ts`, `ipc-server.ts`):
- [ ] Incoming messages validated with Zod (not bare `as` cast)
- [ ] Buffer/message size caps
- [ ] Peer cleanup on disconnect (removePeer in onClose)
- [ ] Connection/handshake timeouts

### Pass 3: Atomicity and Failure-Mode Review

For each subsystem the PR touches, answer these questions:

1. **Source of truth**: What is it? If there are two stores (e.g., DB version counter + R2 manifest JSON), what reconciles them? What if they diverge?

2. **Lock scope**: What's inside the lock/transaction? Are network calls (R2 putObject, external APIs) holding the lock? Could they be moved outside? (Content-addressed uploads can always happen outside the lock.)

3. **Partial failure**: If step N succeeds and step N+1 fails, what state does the system end up in? Is there orphaned data? Is there compensation/cleanup/GC?

4. **Shutdown/restart**: Are watchers, intervals, WebSocket connections, and serial queues cleaned up? Does hot-reload stack up duplicate watchers?

5. **Deferred scope**: If auth, validation, or cleanup is "not in scope yet," is that explicitly stated? Dead authz code (defined but never called) is a trap for future developers.

### Pass 4: Runtime Contract Review (platform/container PRs only)

Many PR #30 misses were not code-local — they were wiring issues visible only when tracing the platform-to-container-to-gateway flow at runtime. For any PR touching `packages/platform/`, `docker-compose*.yml`, or orchestrator code:

1. **Env propagation**: Which env vars does the platform inject into user containers? Are any secrets (PLATFORM_SECRET, DATABASE_URL, S3 credentials) leaking? Trace `buildEnv()` in `orchestrator.ts`.

2. **Internal route auth**: Are internal routes (platform ↔ container) authenticated? Check HMAC/bearer middleware mounting order. Port exposure in docker-compose.

3. **Service contract**: Does the gateway expect headers/env vars the platform actually provides? (e.g., `x-platform-user-id` set but never read, `MATRIX_USER_ID` injected vs header-based identity).

4. **Presigned URL split-horizon**: If presigned URLs are generated, do they use the correct endpoint for the consumer? (Internal services use `minio:9000`, external clients use `localhost:9100` or the public URL.)

5. **Startup/shutdown ordering**: Does the compose dependency graph match the actual readiness requirements? Health checks present and meaningful?

This pass cannot be done from code alone — it requires mentally (or actually) running the flow end-to-end.

## Adversarial Test Requirements

PRs touching these areas must include adversarial tests, not just happy-path:

| Area | Required tests |
|------|---------------|
| Auth/device flow | Concurrent approval/poll |
| File sync | Path traversal attempts (`../`), symlink targets |
| WebSocket handlers | Malformed payloads, oversized messages |
| File operations | Crash-safe temp files (verify temp cleanup) |
| Container env | Verify secrets not forwarded to user containers |
| Shutdown | Cleanup verification (no leaked watchers/connections) |

## For AI Agents

If you are an AI agent (Claude, Copilot, etc.) writing or reviewing code for Matrix OS:

1. **Before writing code**: Run `bun run check:patterns` to see current violations. Don't add new ones.

2. **Before opening a PR**: Run `bun run typecheck && bun run check:patterns && bun run test`. All must pass.

3. **When reviewing a PR**: Use the three-pass structure above. Do NOT review line-by-line. Post ONE structured summary + inline comments only for CRITICAL/HIGH.

4. **Max 20 inline comments per review**. If you find more than 20 HIGH+ issues, the PR is too large — recommend splitting.

5. **Never repeat findings across passes**. Each finding belongs to exactly one pass.

6. **Include "What Looked Good"** in every review. Calibration matters — silent approval of good patterns reinforces them.

## CI Workflow Reference

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `ci.yml` | push/PR to main | typecheck → pattern scan → unit tests → e2e |
| `claude-code-review.yml` | PR opened/sync | Three-pass AI review (code quality) |
| `security-review.yml` | PR touching packages/gateway,kernel,platform | Four-pass AI security review |
| `screenshots.yml` | PR touching shell/** | Playwright visual regression |
| `docker-test.yml` | push/PR to main | Docker scenario tests |
