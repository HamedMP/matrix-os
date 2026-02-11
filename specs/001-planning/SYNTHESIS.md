# Matrix OS -- Synthesis (Agent Analysis Results)

This document synthesizes findings from 4 parallel analysis agents.

## The Big Picture

Matrix OS is a **self-evolving software platform** that:
1. Builds modular software (web apps, CLIs, APIs, libraries) from natural language
2. Composes modules together like LEGO blocks
3. Self-heals when things break
4. **Can expand itself from within** -- after Day 3, you close the IDE and work from inside Matrix OS

## Architecture Decision: Web-First Local Server

All agents converged on this: **everything in the browser**.

- Hono server on Node.js (backend)
- React + Vite (frontend dashboard)
- xterm.js + node-pty (real terminal in browser)
- Monaco Editor (code editor in browser)
- vis-network (module graph visualization)
- WebSocket (real-time updates)
- SQLite (registry, module data)

Why web-first wins:
- Fastest path to impressive UI (drop-in libraries)
- "Build from inside" comes naturally (terminal + editor in browser)
- Easy to demo (screen record the browser)
- Cross-platform by default

## Core Components

### 1. Module Standard
Every generated module follows:
```
modules/<name>/
  manifest.json    # type, deps, interfaces, health config
  package.json     # auto-generated
  src/index.ts     # entrypoint
  tests/           # auto-generated tests
```

Module types: `web`, `cli`, `api`, `cron`, `lib`

Manifest validated with Zod. Modules communicate via:
- Shared SQLite databases (primary, simplest)
- HTTP between services (for web/api modules)
- Environment variable injection for connection info

### 2. Builder Agent
Natural language -> working module via Opus 4.6 tool use.
- Analyzes request + existing modules in registry
- Decides module type, architecture, dependencies
- Generates code via structured tool use (not free-form text)
- Scaffolds files, runs tests, registers, starts

### 3. Healer Agent
Monitors health, auto-repairs broken modules.
- Health check loop (30s interval)
- Error context collection (logs, code, manifest)
- Opus 4.6 diagnosis -> targeted patch
- Test patch, apply, restart
- Rollback if patch fails

### 4. Composer
Wires modules together.
- Dependency graph tracking
- Environment variable injection (ports, DB paths)
- Shared SQLite creation for related modules
- Service discovery

### 5. Runtime
Process lifecycle management.
- Start/stop/restart child processes
- Port allocation (3001-4000 range)
- Log capture (stdout/stderr streaming)
- Process monitoring

### 6. Inner IDE (the self-evolution layer)
This is what makes Matrix OS special:

| Component | Tech | Purpose | Priority |
|-----------|------|---------|----------|
| Terminal | xterm.js + node-pty | Real shell in browser | P0 (Day 3) |
| File System API | Hono REST endpoints | Read/write/list files | P0 (Day 3) |
| AI Chat | Opus 4.6 streaming | NL self-modification | P0 (Day 4) |
| File Browser | Tree view component | Navigate modules/ and src/ | P1 (Day 4) |
| Code Editor | Monaco Editor | Edit source in browser | P1 (Day 5) |
| Module Graph | vis-network | Visualize architecture | P1 (Day 5) |
| Process Manager | Dashboard buttons | Start/stop from UI | P1 (Day 5) |

## Safety: Self-Modification Without Self-Destruction

### Git-Based Snapshots
Before any AI-initiated modification to src/:
1. `git add -A && git commit -m "snapshot before AI modification"`
2. Apply changes
3. Validate (type-check, basic tests)
4. If broken: `git checkout HEAD -- .` (instant rollback)
5. If good: `git commit -m "AI modification: <description>"`

### Watchdog Process
Tiny bash script that monitors Matrix OS core process:
- If it crashes, revert last commit, restart
- Prevents permanent self-bricking

### Protected Files
Terminal, server, and config files require explicit confirmation before AI modification.

### Demo Safety
`git tag demo-safe` before recording. Nuclear rollback option.

## Bootstrapping Sequence

### Phase 1: External Build (Days 1-3 morning)
Build in IDE with Claude Code. Standard development.
- Day 1: Foundation (scaffold, types, registry, CLI)
- Day 2: Builder Agent (Opus 4.6 code generation)
- Day 3 morning: Runtime + Composition (processes, ports, wiring)

### Phase 2: The Inflection Point (Day 3 afternoon)
Build the terminal + file system API. ~4 hours, ~200 lines of backend code.
After this: Matrix OS can modify itself through the browser.

### Phase 3: Hybrid Build (Day 4)
Work in BOTH the external IDE and Matrix OS browser:
- External: Build Healer agent + AI chat panel
- Inside Matrix OS: Build dashboard features using its own terminal + AI chat

### Phase 4: Self-Sustaining (Day 5)
Close the IDE. Work entirely from within Matrix OS.
Polish: code editor, module graph, real-time updates, activity log.

### Phase 5: Demo (Day 6)
Script, dry-run, record, submit.

## Demo Narrative (Revised -- 5 Acts, 3 minutes)

### Act 1: Genesis (0:00-0:45)
- Empty Matrix OS, `matrix-os status` shows nothing
- "I need to track daily expenses with a web interface"
- Builder creates expense-db + expense-web
- Show the running web app

### Act 2: Composition (0:45-1:30)
- "Add a CLI tool to log expenses from terminal"
- Builder creates expense-cli, wires to expense-db
- Demo: `expense-cli add 45 "Groceries"` -> appears in web dashboard
- "Generate weekly reports"
- Builder creates expense-reports module
- Architecture graph grows with each addition

### Act 3: Self-Healing (1:30-2:00)
- Intentionally break expense-web (corrupt a database query)
- Health check detects failure
- Healer diagnoses, patches, restarts
- Web app works again. "It healed itself."

### Act 4: Self-Evolution (2:00-2:30)
THE HOLY SHIT MOMENT.
- Open AI chat inside Matrix OS
- "Add a dark mode toggle to the dashboard"
- Opus 4.6 reasons about CSS changes
- File modification happens live (visible in activity log)
- Refresh: dark mode toggle appears
- Click it: dashboard switches to dark mode
- "Matrix OS just modified its own interface."

### Act 5: The Big Picture (2:30-3:00)
- Zoom out: dashboard showing full module graph
- Terminal, editor, AI chat, graph -- all in one screen
- "This started as an empty system 5 minutes ago."
- "Every piece was built by describing what we needed."
- "When something broke, it fixed itself."
- "When we wanted more, it built more -- including improvements to itself."
- "This is Matrix OS."

## Reusable Patterns from Clawdbot

From the Explorer agent's analysis of Clawdbot/Finna:

| Pattern | Clawdbot Source | Matrix OS Use |
|---------|----------------|---------------|
| Tool use with Opus 4.6 | `src/agents/pi-tools.ts` | Builder/Healer structured output |
| Shell execution + PTY | `src/agents/bash-tools.exec.ts` | WebSocket terminal backend |
| Streaming responses | `src/agents/pi-embedded-subscribe.ts` | AI chat streaming, build progress |
| Auth profile rotation | `src/agents/auth-profiles.ts` | Failover if API rate-limited |
| Plugin runtime DI | `src/plugins/runtime/types.ts` | Module capability registration |
| Session transcripts | `src/memory/session-files.ts` | Build/heal logging |
| Config with Zod | `src/config/config.ts` | Module manifest validation |

## Tech Stack (Final)

| Component | Technology | Notes |
|-----------|-----------|-------|
| Language | TypeScript (strict, ESM) | |
| Runtime | Node.js 22+ | |
| AI Engine | Claude API (Opus 4.6) | Structured tool use for generation |
| Web Server | Hono | Lightweight, WebSocket support |
| Frontend | React + Vite | Fast dev, component reuse |
| Database | SQLite (better-sqlite3) | Registry + module data |
| Terminal | xterm.js + @lydell/node-pty | Clawdbot uses this fork |
| Editor | Monaco (@monaco-editor/react) | VS Code quality, 3 lines of JSX |
| Graph | vis-network | Easier than D3, still impressive |
| Reverse Proxy | httpxy (UnJS) | Route web modules through dashboard URL |
| Validation | Zod | Schema validation + TS types |
| Testing | Vitest | Fast, native ESM |
| Bundler | Vite (frontend) + tsx (backend dev) | |

## Key Findings from Tech Research

### Confirmed Choices
- **xterm.js + node-pty**: No real alternative. Used by VS Code, code-server, Gitpod. Industry standard.
- **Monaco Editor**: Wins over CodeMirror 6 for hackathon. 3 lines of JSX, built-in TypeScript IntelliSense, instant "wow factor". Bundle size (2.4MB) irrelevant for desktop app.
- **child_process over PM2/Docker**: Zero deps, full control, sufficient for demo scale.

### New Additions
- **httpxy** (UnJS): Modern TypeScript reverse proxy. Route all web modules through dashboard URL (`/modules/expense-web/*` -> `localhost:4001/*`). Judges see one clean URL, not scattered ports.
- **Multiplexed WebSocket logs**: Single WS connection for all module logs. Server tags each message with module name + stream type. Dashboard routes to correct panel.
- **Module backups before healing**: `cp -r` module source before patching. Rollback if tests fail. Simple and reliable.

### Relevant Precedents
- **bolt.diy** (open source bolt.new): Closest existing project. AI generates + runs code in browser. Study its layout (chat left, editor/preview right) and streaming code generation UX. Key difference: bolt.diy generates disposable apps; Matrix OS builds a living system.
- **Darwin Godel Machine** (Sakana AI, 2025): Self-improving coding agent that rewrites its own code. Key insight: use empirical evaluation (run tests) instead of formal proofs. Generate patch -> test -> keep if pass. Exactly our Healer pattern.
- **MAPE-K loop**: Monitor -> Analyze -> Plan -> Execute -> Knowledge. Academic backing for our Healer design.

### Module Lifecycle (VS Code + Obsidian pattern)
```
REGISTERED -> STARTING -> RUNNING -> STOPPING -> STOPPED
                 |                      |
                 v                      v
              ERROR  <-- HEALING --> HEALED -> RUNNING
```
Two lifecycle hooks: start and stop. Everything else declared in manifest. Don't over-engineer.

### What NOT to Use
| Technology | Why Not |
|-----------|---------|
| WebContainers | Adds complexity -- we have a server, use it |
| Eclipse Theia / OpenSumi | Too large for 6 days |
| Docker for modules | Setup overhead, overkill for demo |
| vm2 | Critical CVEs, discontinued |
| CodeMirror 6 | More assembly for TypeScript support; Monaco gives it free |
| PM2 | Unnecessary abstraction at demo scale |

## Estimated New Code for Inner IDE

| File | Lines | Day |
|------|-------|-----|
| `routes/terminal.ts` | ~80 | 3 |
| `routes/fs.ts` | ~120 | 3 |
| `routes/ai-chat.ts` | ~150 | 4 |
| `shared/safe-modify.ts` | ~80 | 4 |
| `Terminal.tsx` | ~60 | 3 |
| `FileBrowser.tsx` | ~100 | 4 |
| `Editor.tsx` | ~80 | 5 |
| `watchdog.sh` | ~15 | 4 |
| **Total** | **~685** | |

The inner IDE is ~685 lines on top of the core system. Feasible.

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| node-pty compilation fails | Fallback: `child_process.spawn('bash')` without PTY |
| Code generation produces broken modules | Validation step + retry loop (feed errors back to Opus) |
| AI self-modification breaks core | Git snapshots + watchdog auto-revert |
| Self-healing unreliable for demo | Pre-test demo scenario, use "known fixable" break patterns |
| Dashboard takes too long | Terminal is P0, everything else degrades gracefully |
| Scope creep | P0 only until Day 4. Polish over features. |
| Monaco too heavy to load | Fallback: CodeMirror 6 (lighter) or even textarea |
