# Architecture Analysis Feedback

Review by four analysis agents (Systems Architect, Infrastructure Engineer, AI/LLM Systems Engineer, Product/UX Engineer) against FINAL-SPEC.md and KERNEL-AND-MEMORY.md.

## Reference Documentation

Actual SDK and Claude Code docs are available for verification:

- **Agent SDK docs:** `matrix-os/docs/agent-sdk/` -- TypeScript SDK, streaming, hooks, sessions, permissions, subagents, MCP, plugins, structured outputs, etc.
- **Claude Code docs:** `matrix-os/docs/claude-code-docs/` -- Agent teams, sub-agents (the Claude Code CLI perspective)

These are the source of truth for verifying API surface, flag names, hook signatures, and capabilities assumed in the spec.

---

## Cross-Cutting Findings

All four reviewers agreed on three things:

1. **The computer architecture metaphor is strong and consistent.** Context window as RAM, Agent SDK as kernel, sub-agents as processes -- this maps well and drives good design decisions.

2. **Concurrency is the biggest architectural risk.** `processes.json` and `state.md` as writable shared files will fail under concurrent kernel instances. Every reviewer flagged this independently.

3. **Token economics need explicit budgeting.** Opus 4.6 calls are expensive ($2-3 per complex build) and slow (30-90 seconds). The demo must account for this.

---

## 1. Systems Architect Review

### Architecture Soundness

The Smart Kernel (Approach A) is correct for a hackathon. Avoids the complexity of a thin kernel that must always route through sub-agents.

### Agent SDK Reality Check

| Issue | Severity | Detail |
|-------|----------|--------|
| Permission flag naming | High | Spec uses `permissionMode: "bypassPermissions"` -- verify against actual SDK docs. The real flag may differ. |
| No streaming in kernel code | High | Spec shows `const result = await query(...)` but the SDK streams via `for await (const message of query(...))`. Must stream for responsiveness. |
| Hooks referenced but undefined | Medium | `updateStateHook`, `notifyShellHook`, `gitSnapshotHook`, `safetyGuardHook` are named but have no implementation sketched. |
| state.md merge conflicts | Medium | Two concurrent kernels editing state.md = corruption. |

**Decision:** Agent SDK docs now added to `matrix-os/docs/agent-sdk/`. Will verify all API surface details against actual SDK before building.

### Recommendations

- [x] **DECIDED: state.md becomes read-only** -- generated from SQLite source of truth on every read
- [ ] Put hard timeout limits on `query()` calls (120s default, 300s max for builder)
- [ ] Move git snapshot hooks to SubagentStop events (snapshot after work, not during every file write)

---

## 2. Infrastructure Engineer Review

### Node.js Concurrency

The spec proposes multiple concurrent `query()` calls (multiprocessing). Node.js is single-threaded per process. CPU-bound work in hooks or prompt assembly will block all concurrent calls on the same event loop.

### Multiprocessing Solution

**Question raised:** What approach supports true multiprocessing if Node.js can't do it natively?

**Answer: Async concurrency is likely sufficient, with `child_process.fork()` as the escape hatch.**

Three options, in order of simplicity:

**Option A: Async concurrency in a single process (try this first)**

`query()` is I/O-bound -- it spends 95%+ of its time waiting on the Claude API. Multiple concurrent `query()` calls in a single Node.js process work fine because the event loop handles I/O multiplexing natively. The "blocking" concern is real but tiny: prompt assembly and hook execution take milliseconds, while API latency is seconds-to-minutes.

```typescript
// This works. Multiple concurrent queries share one event loop.
// Each spends 99% of time awaiting API response, not blocking.
const results = await Promise.allSettled([
  spawnKernel("Build me a CRM", sessionA),
  spawnKernel("Fix the notes app", sessionB),
  spawnKernel("What's the weather?", sessionC),
]);
```

Pros: Zero overhead, simplest code, shared SQLite connection.
Cons: A truly CPU-heavy hook (unlikely) could momentarily block others.

**Option B: Worker threads (`worker_threads` module)**

Each kernel instance runs in its own V8 isolate with its own event loop. Can share memory via SharedArrayBuffer. Communication via message passing.

```typescript
import { Worker } from 'worker_threads';

function spawnKernelWorker(message: string, sessionId?: string) {
  return new Worker('./kernel-worker.js', {
    workerData: { message, sessionId }
  });
}
```

Pros: True isolation, no event loop contention.
Cons: Each worker has its own module cache (higher memory), can't share SQLite `better-sqlite3` connection (it's native and not transferable). Each worker needs its own DB connection.

**Option C: Child processes (`child_process.fork()`)**

Full OS-level process isolation. Each kernel runs in a completely separate Node.js process. Communication via IPC message passing.

```typescript
import { fork } from 'child_process';

function spawnKernelProcess(message: string, sessionId?: string) {
  const child = fork('./kernel-process.js', [], {
    env: { ...process.env, KERNEL_MESSAGE: message, SESSION_ID: sessionId }
  });
  return new Promise((resolve) => {
    child.on('message', resolve);
  });
}
```

Pros: Complete isolation, can kill a stuck kernel without affecting others, OS-level resource limits.
Cons: Higher memory overhead (~50MB per process), slower startup, IPC serialization cost.

**Recommendation: Start with Option A.** The `query()` function is fundamentally async I/O. Concurrent calls in a single process will work. If during development we discover blocking issues, escalate to Option B (workers) for CPU-bound hooks, or Option C (fork) for full isolation. This is a hackathon -- don't prematurely optimize.

SQLite with WAL mode handles concurrent reads from any approach. `better-sqlite3` with WAL mode supports multiple readers + one writer per connection. For Options B/C, each worker/process opens its own connection to the same SQLite file.

### Top 5 Failure Modes

| # | Failure | Cause | Mitigation |
|---|---------|-------|------------|
| 1 | Process table race condition | Two kernels write simultaneously | **DECIDED: Use SQLite** with WAL mode for process table |
| 2 | State lost updates | Concurrent kernel writes | **DECIDED: state.md is read-only**, generated from DB |
| 3 | Port collision | Two builders allocate same port | Pre-allocate ports in SQLite with row-level locking |
| 4 | Zombie sub-agent processes | Builder spawns `npm install`, parent terminates | Track all child PIDs, cleanup on kernel exit |
| 5 | chokidar file watcher overwhelm | Builder writes 50+ files rapidly | Debounce file events (500ms), batch shell notifications |

### Open Questions

- [ ] **Q: Should we use WAL mode or DELETE journal mode for SQLite?** WAL is better for concurrent reads but slightly more complex (WAL file + SHM file alongside the DB). For a single-writer scenario it's the clear winner.
- [ ] **Q: Should port allocation be a pre-allocated pool or dynamic?** Pool is simpler (allocate port 4000-4099, claim in DB). Dynamic is more flexible but needs TCP probe to verify availability.

---

## 3. AI/LLM Systems Engineer Review

### Context Window Budget

| Component | Tokens | % of 200K |
|-----------|--------|-----------|
| Static system prompt (BIOS) | ~2,000 | 1% |
| state.md (L1 cache) | ~500 | 0.25% |
| Knowledge TOC | ~800 | 0.4% |
| Conversation context (L2) | ~10,000-50,000 | 5-25% |
| Tool results (accumulated) | ~20,000-40,000 | 10-20% |
| **Available for reasoning** | **~100,000-165,000** | **50-80%** |

Key insight: **tool results accumulate fast**. After 10 tool calls (Read, Bash, Glob), tool results consume 15-20% of context. Builder agents reading source files and running commands hit this quickly.

### Routing Accuracy

Estimated ~80-85% correct routing by the smart kernel. Ambiguous requests ("make it better", "this is slow") may go to the wrong sub-agent or be handled directly when they should be delegated.

### Builder Success Rates & Economics

| Complexity | Success Rate | Latency | Cost (Opus) |
|-----------|-------------|---------|-------------|
| Simple HTML app (single file) | 90%+ | 15-30s | ~$0.50 |
| Multi-file app with state | 70-80% | 30-60s | ~$1-2 |
| Full-stack with DB + API | 50-70% | 60-90s | ~$2-3 |
| Complex app with integrations | 40-60% | 90-120s+ | ~$3-5 |

### Recommendations

- [ ] Define structured result contracts: sub-agents write results to specific file paths, not return them in conversation -- **DECISION: Will be part of planning phase**
- [ ] Set explicit context budgets per sub-agent (builder gets 150K, healer gets 100K)
- [ ] Pre-seed 2-3 demo apps to avoid generation latency during demo video

### Open Questions

- [ ] **Q: Should we use Sonnet for simple routing decisions to save cost/latency?** The kernel could use Sonnet for triage ("is this simple or complex?") then Opus for execution. Adds complexity but could cut routing latency from 5s to 1s.
- [ ] **Q: How to handle context overflow in long builder sessions?** The builder may need to read many files. Should it summarize intermediate results to free context, or just accept the 200K limit as a hard cap on complexity?
- [ ] **Q: Should sub-agents get fresh context or inherit from kernel?** Fresh context = clean but loses conversation history. Inherited = has context but burns tokens on irrelevant history.

---

## 4. Product/UX Engineer Review

### First Screen Design

The spec is vague on what users see when they open Matrix OS. Recommended layout:

```
+--------------------------------------------------+
|  Matrix OS                              [?] [=]  |
|                                                    |
|                                                    |
|              What would you like to build?         |
|              [________________________]            |
|                                                    |
|  Examples:                                         |
|  "Build me a budget tracker"                       |
|  "Create a notes app with markdown"                |
|  "Track my daily habits"                           |
|                                                    |
|  +------+  +------+  +------+  +------+           |
|  | Apps |  | Term |  |Files |  | Chat |           |
|  +------+  +------+  +------+  +------+           |
+--------------------------------------------------+
```

Centered chat input, example prompts below, dock at bottom. Desktop fills with app windows as they're created.

### Loading State (Critical UX)

The 30-90 second generation window is the biggest UX challenge. Users must see activity, not a spinner.

- Stream kernel reasoning in an activity feed ("Analyzing request...", "Scaffolding structure...", "Writing components...", "Installing dependencies...")
- Show a live file tree that populates as files are created
- Progress bar based on expected file count

### iframe Challenges for Generated Apps

| Issue | Problem | Mitigation |
|-------|---------|------------|
| Focus management | Clicking iframe captures keyboard, breaks OS shortcuts | Add focus trap handler, listen for blur events |
| Scrolling conflicts | Nested scroll containers | Use `overflow: hidden` on iframe, let app handle its own scroll |
| Theme injection | Can't style iframe content from outside | Inject theme CSS via URL param or postMessage |
| Same-origin policy | Apps on different ports can't communicate | Use reverse proxy (httpxy) so all apps serve from same origin |

### Demo Pacing (3-Minute Video)

| Segment | Time | What happens |
|---------|------|-------------|
| Intro + empty desktop | 0:00-0:15 | "This is Matrix OS" |
| Build simple app (pre-seeded, fast) | 0:15-0:45 | Voice command, app appears |
| Iterate on app | 0:45-1:15 | "Add dark mode" -- live modification |
| Build connected module | 1:15-1:45 | Show composition, module graph |
| Self-healing demo | 1:45-2:15 | Break something, watch auto-repair |
| Self-evolution moment | 2:15-2:45 | "Add a feature to the OS itself" |
| Closing shot | 2:45-3:00 | Full desktop with multiple apps |

**Pre-seeding strategy:** Have 2-3 apps already built but hidden. The "build" command triggers a fast builder run that produces the pre-built app within 10-15 seconds. Keeps the demo moving.

### Open Questions

- [ ] **Q: Should the shell be a full desktop metaphor (windows, taskbar, drag-to-resize) or a simpler panel layout?** Desktop metaphor is more impressive but takes days to build well. Panel layout (like VS Code) is faster to implement.
- [ ] **Q: Voice input -- is it worth implementing for the demo?** Web Speech API is free and works in Chrome. Adds "wow factor" but might be unreliable during recording. Could fake it with a typing animation.
- [ ] **Q: Should generated apps open in the OS shell or in a new browser tab?** Shell keeps the OS metaphor alive. New tab is simpler. Recommend shell with a "pop out" button.

---

## Prioritized Action Items

### Must Fix Before Building (Day 1)

1. [x] **Replace processes.json with SQLite table** -- DECIDED
2. [x] **Make state.md read-only, generated from DB** -- DECIDED
3. [ ] **Verify Agent SDK API surface** against docs in `matrix-os/docs/agent-sdk/` -- streaming, permission flags, hooks, sub-agent spawning
4. [ ] **Define structured result contracts** for sub-agents -- DECIDED: part of planning

### Must Design Before Demo (Day 3-4)

5. [ ] Loading state UX during app generation (streaming progress)
6. [ ] First screen / empty state design
7. [ ] Pre-seeding strategy for demo reliability

### Should Address (Day 5-6)

8. [ ] iframe theme injection approach
9. [ ] Context budget monitoring / guardrails
10. [ ] Watchdog process for crash recovery

---

## All Open Questions (Collected)

### Multiprocessing & Concurrency
- [x] **What supports multiprocessing if Node.js can't?** -- ANSWERED: Async concurrency in single process is sufficient (query() is I/O-bound). Escalate to worker_threads or child_process.fork() only if needed.
- [ ] WAL mode vs DELETE journal for SQLite?
- [ ] Pre-allocated port pool or dynamic allocation?

### Agent SDK & API
- [ ] Verify exact permission bypass flag name
- [ ] Verify streaming API (`for await` pattern vs callback)
- [ ] Verify hooks API (PostToolUse matcher syntax, hook function signature)
- [ ] Verify sub-agent spawning (Task tool config, agent definitions)
- [ ] How do Agent SDK sessions actually work? (resume, session ID format)

### Token Economics & Context
- [ ] Use Sonnet for routing triage to save cost/latency?
- [ ] How to handle context overflow in long builder sessions?
- [ ] Should sub-agents get fresh context or inherit from kernel?
- [ ] What's the actual token cost of the system prompt + knowledge TOC?

### UX & Demo
- [ ] Desktop metaphor (windows) vs panel layout (VS Code-like)?
- [ ] Voice input via Web Speech API -- worth it for demo?
- [ ] Generated apps in OS shell vs new browser tab?
- [ ] How to make 30-90s generation feel fast in a 3-minute demo?

### Safety & Self-Modification
- [ ] Git snapshot on every file write (expensive) vs on sub-agent completion (cheaper)?
- [ ] Protected files list -- which files should be un-modifiable by the OS itself?
- [ ] Watchdog process design -- bash script or Node.js child?
- [ ] Max healing attempts before giving up (2? 3?)?
