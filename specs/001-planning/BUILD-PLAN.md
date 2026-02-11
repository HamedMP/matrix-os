# Matrix OS -- Build Plan

## Timeline: Feb 10-16 (6 days + buffer)

### Day 1: Tuesday, Feb 10 -- Foundation

**Goal:** Project scaffold + module standard + basic registry

- [ ] Initialize TypeScript project (strict, ESM)
- [ ] Define module manifest schema (TypeScript types + JSON schema)
- [ ] Build module registry (SQLite or JSON-based)
  - Register/unregister modules
  - Query modules by type, capability, status
  - Dependency graph tracking
- [ ] Create example module by hand (a simple `lib` module) to validate the standard
- [ ] Basic CLI entry point (`matrix-os` command)

**End of day:** Can manually create and register a module.

### Day 2: Wednesday, Feb 11 -- Builder Agent

**Goal:** Opus 4.6 generates working modules from natural language

- [ ] Builder agent: natural language → module plan
  - Analyze request
  - Check existing modules in registry
  - Decide module type, dependencies, interfaces
- [ ] Builder agent: plan → generated code
  - Generate manifest.json
  - Generate source code
  - Generate basic tests
- [ ] Module scaffolding system (create dirs, write files)
- [ ] Validation: run generated tests, type-check
- [ ] Integration: generate → register → ready

**End of day:** "I need a library to manage todo items" → working module on disk.

### Day 3: Thursday, Feb 12 -- Runtime + Composition

**Goal:** Modules actually run and talk to each other

- [ ] Module runtime: start/stop processes
  - Port allocation for web/api modules
  - Process monitoring (alive/dead)
  - Log capture
- [ ] Composer: wire modules together
  - Inject connection info (ports, paths) via env vars
  - Shared SQLite databases for related modules
  - Service discovery
- [ ] Support `web` module type (generate working web apps)
- [ ] Support `cli` module type (generate working CLI tools)
- [ ] Test: build a `lib` + `web` that compose together

**End of day:** Can generate a web app + library module, they share data, both run.

### Day 4: Friday, Feb 13 -- Self-Healing + Dashboard Start

**Goal:** Healing works, dashboard shows system state

- [ ] Health check loop
  - Periodic checks on all running modules
  - Detect crashes, HTTP failures, error spikes
- [ ] Healer agent
  - Collect error context (logs, code, manifest)
  - Opus 4.6 diagnosis: root cause analysis
  - Generate patch, test it, apply it
  - Restart healed module
- [ ] Web dashboard (start)
  - System overview page
  - Module list with status indicators
  - Natural language input bar
  - Activity/build log

**End of day:** Break a module intentionally, watch it heal. Basic dashboard running.

### Day 5: Saturday, Feb 14 -- Dashboard + Polish

**Goal:** Dashboard is compelling, module graph works, full flow polished

- [ ] Module graph visualization (interactive, shows connections)
- [ ] Dashboard: module detail view (code, logs, health)
- [ ] Dashboard: real-time updates (WebSocket or polling)
- [ ] Healing events visible in dashboard
- [ ] Polish builder: better code generation, smarter architecture decisions
- [ ] Polish CLI output (clear, informative)
- [ ] End-to-end walkthrough: build 4-5 modules from scratch, compose them, heal one

**End of day:** Full demo scenario works end-to-end.

### Day 6: Sunday, Feb 15 -- Demo + Submission Prep

**Goal:** Record demo, write summary, prepare repo

- [ ] Script the 3-minute demo (exact words, exact sequence)
- [ ] Dry-run the demo scenario 2-3 times
- [ ] Record the demo video
  - Clean terminal/browser setup
  - Good pacing, clear narration
  - Edit if needed (cuts, zoom-ins on key moments)
- [ ] Prepare GitHub repo
  - Clean README with project overview
  - Setup instructions
  - Architecture diagram
  - License (MIT or Apache 2.0)
- [ ] Write 100-200 word submission summary

### Day 7: Monday, Feb 16 -- Buffer + Submit

**Goal:** Final polish, submit before 3:00 PM EST

- [ ] Final README review
- [ ] Final demo video review
- [ ] Submit on CV platform before deadline

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Code generation produces broken modules | Have fallback templates for common module types; validation step catches errors before registration |
| Self-healing is unreliable | Pre-test the demo healing scenario; have a "known fixable" break pattern |
| Dashboard takes too long | Start with minimal dashboard, graph viz is a stretch; plain HTML with htmx is fine |
| Opus 4.6 API rate limits | Cache common generation patterns; batch requests where possible |
| Scope creep | P0 features only until Day 4. Polish over features. |

## Demo Scenario (Scripted)

This is the exact scenario to record:

1. Show empty Matrix OS (`matrix-os status` → "No modules")
2. "I need to track my daily expenses with a web interface"
   → Builder creates `expense-db` (lib) + `expense-web` (web)
   → Show the web app running in browser
3. "Add a CLI tool so I can log expenses from terminal"
   → Builder creates `expense-cli`, wires to `expense-db`
   → Demo: `expense-cli add 45.00 "Groceries"` → appears in web dashboard
4. "I want weekly expense reports"
   → Builder creates `expense-reports` (lib/cron), composes with `expense-db`
5. Break something (manually corrupt a query in `expense-web`)
   → Health check detects failure
   → Healer diagnoses, patches, restarts
   → Web app works again
6. Show dashboard: full module graph, all healthy, build/heal history

Total: ~3 minutes of "software building itself"
