---
description: Review spec/plan/tasks for security, integration wiring, failure modes, and resource management gaps before implementation.
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Goal

Identify gaps in spec.md, plan.md, and tasks.md that would result in security vulnerabilities, broken integration wiring, unhandled failures, or resource leaks in the implemented code. This review catches the class of bugs that unit tests miss -- the ones that only surface when components are wired together in production.

This command was created after PR #17 (voice system) where 55+ review findings traced back to gaps in the planning phase. The 6 categories below are derived from that analysis.

## Operating Constraints

**STRICTLY READ-ONLY**: Do not modify any files. Output a structured review report with findings and recommendations.

**Constitution Authority**: `.specify/memory/constitution.md` is the source of truth. Principle VII (Defense in Depth) defines mandatory security requirements. Violations are automatically CRITICAL.

## Execution Steps

### 1. Locate Spec Files

If `$ARGUMENTS` specifies a spec directory or number, use that. Otherwise, detect the current feature from the git branch name or ask.

Find these files in `specs/{NNN}-{feature-name}/`:
- `spec.md` (required)
- `plan.md` (required)
- `tasks.md` (optional but recommended)

Also load:
- `.specify/memory/constitution.md` (for principle validation)
- `CLAUDE.md` "Spec Quality Gates" section (for checklist criteria)

Abort if spec.md or plan.md is missing.

### 2. Extract Review Surface

From the spec and plan, extract:

**Endpoints**: Every HTTP route, WebSocket endpoint, webhook URL, and IPC tool. For each, note:
- Path and method
- Auth requirement (if specified)
- Input parameters and their sources
- Response format

**Components**: Every class, service, store, or provider. For each, note:
- How it's instantiated
- How it's initialized (constructor args, `.initialize()` calls)
- What it connects to (other components, external APIs)
- What state it holds (in-memory maps, files, timers)

**External calls**: Every `fetch()`, API call, or outbound connection. Note:
- Target URL/service
- Timeout (if any)
- Error handling
- Data sent externally

**File I/O**: Every file read/write operation. Note:
- Path construction (is it sanitized?)
- Write atomicity
- Cleanup/rotation policy

### 3. Run 6 Review Passes

#### Pass 1: Security Architecture

Check for:

- [ ] **Auth matrix exists**: Every endpoint/WebSocket/webhook has an explicit auth method documented
- [ ] **No auth gaps**: No endpoint is silently unprotected. Watch for:
  - New routes added to `server.ts` without auth middleware
  - WebSocket endpoints bypassing REST auth
  - Webhook routes using prefix matching (startsWith) that could match unintended paths
  - Public routes that should be authenticated
- [ ] **Input validation at boundaries**: Every user-facing input (query params, body fields, file paths, filenames, webhook payloads) has validation specified
- [ ] **No internal leaks**: Error responses don't expose provider names, stack traces, internal state, or credentials
- [ ] **Credential safety**: Tokens/keys never appear in URLs, error messages, or logs. HMAC/signature checks use constant-time comparison
- [ ] **Header trust**: Security-critical decisions don't rely on user-controllable headers (X-Forwarded-*, Host)

**Severity**: Missing auth matrix = CRITICAL. Missing input validation = HIGH. Info leaks = MEDIUM.

#### Pass 2: Integration Wiring

Check for:

- [ ] **All components instantiated**: Every provider/service/store described in the spec has a corresponding instantiation in the startup sequence
- [ ] **All components initialized**: Components with `.initialize()` methods are actually called (not just constructed)
- [ ] **All components connected**: If component A needs component B, the wiring is described (not assumed via globalThis or other magic)
- [ ] **No placeholder values**: Config values (phone numbers, webhook URLs, API endpoints) come from real config/env, not hardcoded strings
- [ ] **Cross-package communication**: If kernel needs gateway state (or vice versa), the mechanism is explicit (IPC, HTTP, dependency injection -- not shared memory)
- [ ] **Provider registration**: If a provider map/registry exists, all production providers are registered (not just mocks)

**Severity**: Component never initialized = CRITICAL. Hardcoded placeholders = HIGH. Missing wiring = HIGH.

#### Pass 3: Failure Modes

Check for:

- [ ] **Timeouts on all external calls**: Every fetch, dispatch, or provider API call has an explicit timeout. No unbounded waits.
- [ ] **Error propagation**: Errors from critical operations are not silently swallowed. Watch for:
  - Empty `catch {}` blocks
  - Webhook handlers returning 200 on error (prevents provider retry)
  - Promises with no `.catch()` or error handler
- [ ] **Concurrent access safety**: State shared between connections/requests is guarded. Watch for:
  - Variables captured in closures that should be per-connection
  - TOCTOU races in limit enforcement (check-then-act without atomicity)
  - State machine events arriving during async operations
- [ ] **Post-destroy guards**: Components with `destroy()`/`stop()` methods have guards preventing side effects after cleanup
- [ ] **Crash recovery**: File writes use atomic patterns. State can be recovered after a crash.

**Severity**: No timeout on dispatch = HIGH. Error swallowing = MEDIUM. Shared state bugs = HIGH.

#### Pass 4: Resource Management

Check for:

- [ ] **Buffer size limits**: Every in-memory collection (arrays, Maps, Sets) that grows with input has a cap
- [ ] **Eviction cleanup**: When items are evicted/removed from collections, ALL associated state is cleaned up (related maps, sets, timers)
- [ ] **File cleanup policy**: Generated files (audio, logs, temp files) have a TTL, rotation, or size limit
- [ ] **Timer cleanup**: setTimeout/setInterval handles are cleared on success, not just on error
- [ ] **Third-party disclosure**: Data sent to external services (especially free-tier/no-auth services) is documented

**Severity**: Unbounded buffer = HIGH. Memory leak on eviction = MEDIUM. No file cleanup = LOW.

#### Pass 5: Integration Test Coverage

Check for:

- [ ] **End-to-end path tested**: Each major feature path has at least one integration test that exercises the full chain (API call -> business logic -> persistence -> response)
- [ ] **Wiring tested**: Components that are wired together in server.ts are tested as a connected system, not just individually
- [ ] **Phase checkpoints include integration tests**: Each checkpoint mentions more than just "bun run test passes"

**Severity**: No integration tests for critical path = HIGH. Unit-only checkpoints = MEDIUM.

#### Pass 6: Concurrency & State

Check for:

- [ ] **Per-connection state**: WebSocket handlers, request handlers allocate state per-connection (not in enclosing closure)
- [ ] **Atomic limit enforcement**: Rate limits, concurrent call limits, etc. use atomic operations (not check-then-act)
- [ ] **State machine guards**: State machines handle concurrent events arriving during async transitions
- [ ] **Boolean/flag correctness**: State flags (isPlaying, isRecording, enabled) are set at the right time, not just cleared

**Severity**: Shared connection state = HIGH. TOCTOU = MEDIUM. Missing flag updates = MEDIUM.

### 4. Produce Review Report

Output a Markdown report (no file writes):

```markdown
## Spec Review Report: {feature-name}

**Spec**: {path to spec.md}
**Plan**: {path to plan.md}
**Tasks**: {path to tasks.md or "not found"}
**Date**: {today}

### Summary

| Category | Critical | High | Medium | Low | Pass |
|----------|----------|------|--------|-----|------|
| Security | X | X | X | X | X |
| Integration Wiring | X | X | X | X | X |
| Failure Modes | X | X | X | X | X |
| Resource Management | X | X | X | X | X |
| Integration Tests | X | X | X | X | X |
| Concurrency & State | X | X | X | X | X |

**Verdict**: {BLOCK / WARN / PASS}
- BLOCK: Any CRITICAL finding. Do not implement until resolved.
- WARN: HIGH findings only. Can proceed but address before PR.
- PASS: MEDIUM/LOW only. Proceed with implementation.

### Findings

| ID | Category | Severity | Location | Finding | Recommendation |
|----|----------|----------|----------|---------|----------------|
| S1 | Security | CRITICAL | spec.md | No auth matrix for /api/voice/* endpoints | Add auth matrix table listing every endpoint and its auth method |
| W1 | Wiring | HIGH | plan.md Phase C | CallStore created but never connected to CallManager | Add wiring step in server.ts startup sequence |
| ... | ... | ... | ... | ... | ... |

### Missing Spec Sections

List any mandatory sections from CLAUDE.md "Spec Quality Gates" that are absent:

- [ ] Security Architecture (auth matrix, input validation, error policy, credentials)
- [ ] Integration Wiring (startup sequence, cross-package comm, config injection)
- [ ] Failure Modes (timeouts, concurrent access, crash recovery, error propagation)
- [ ] Resource Management (buffer limits, eviction cleanup, file cleanup, third-party disclosure)
- [ ] Integration Test Checkpoint (per-phase e2e test)

### Recommended Additions

For each missing section, provide a concrete template the spec author can fill in.
```

### 5. Offer Remediation

After the report, ask:

> "Would you like me to add the missing sections to the spec? I'll generate templates pre-filled with what I can infer from the existing spec and mark gaps with [TODO]."

Do NOT apply changes automatically.

## Reference: Common Patterns That Cause Review Findings

These patterns, observed in PR #17 (55+ findings), recur across specs:

1. **"All endpoints behind auth middleware"** (one sentence) -> 6 auth bypass bugs. The fix: explicit auth matrix table.
2. **Components designed in separate tasks** with no wiring task -> 4 CRITICAL bugs (never initialized, never connected). The fix: explicit startup sequence.
3. **"Webhook security: HMAC-SHA1"** (one sentence) -> 5 HMAC bugs (timing-unsafe, header spoofing, URL reconstruction). The fix: threat model for webhook verification.
4. **No mention of timeouts** -> 4 hang/DoS bugs. The fix: timeout policy per external call.
5. **No mention of concurrent access** -> 4 shared-state bugs. The fix: per-connection state design.
6. **No mention of cleanup** -> 5 resource leak bugs. The fix: resource limits section.
7. **Unit tests pass, integration never tested** -> all CRITICAL wiring bugs passed 580 unit tests. The fix: integration test checkpoints.
