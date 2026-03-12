# Plan: App Platform

**Spec**: spec.md
**Tasks**: tasks.md

## Execution Order

```
Phase A: App Runtime (T1400-T1409)        -- foundation, everything depends on this
  |
  +---> Phase B: Desktop Apps (T1410-T1414)   -- depends on runtime for process management
  |
  +---> Phase D: Utility Apps (T1430-T1434)   -- can start with static, upgrade to runtime
  |
  +---> Phase G: Local Dev Sync (T1460-T1464) -- depends on runtime for upload API
  |
Phase C: Games (T1420-T1429)              -- independent, static HTML, can start immediately
  |
Phase E: Skills (T1440-T1449)             -- independent, just .md files
  |
Phase F: Skills Store (T1450-T1454)       -- depends on E for content, platform API for registry

```

## Phase Breakdown

### Week 1: Foundation + Games (parallel)
- **Stream 1**: App runtime (T1400-T1403) -- manifest schema, process manager, gateway integration
- **Stream 2**: Games (T1420-T1427) -- all static HTML, fully independent. Start with Solitaire and Chess as they're the most viral.

### Week 2: Desktop Apps + Utilities
- **Stream 1**: Chrome + VS Code integration (T1410-T1412) -- requires runtime for process management
- **Stream 2**: Utility apps (T1430-T1434) -- File Manager, Calculator, Calendar, Clock

### Week 3: Skills + Sync
- **Stream 1**: AI skills for app building (T1440-T1445) -- just .md files, quick to write
- **Stream 2**: Local dev sync (T1460-T1463) -- upload API, CLI tool, chat install

### Week 4: Skills Store + Polish
- Skills store backend + UI (T1450-T1454)
- Polish all apps, ensure consistent theming
- Integration testing across all apps

## Key Decisions

1. **matrix.json over matrix.md**: JSON is easier to parse programmatically, validate with Zod, and generate. Keep backward compat with matrix.md.
2. **Process manager over full Docker**: For most apps, a Node.js child_process is sufficient. Docker only for heavyweight apps (Chrome, VS Code) where isolation matters.
3. **Games as static HTML**: No build step, instant load, easy to modify. Use canvas for smooth animations.
4. **Skills store shares UI with App Store**: One store, multiple tabs (Apps, Games, Skills). Don't build separate UIs.

## Risk Mitigation

- **Chrome resource usage**: Gate behind "Pro" feature flag. Lazy-load: don't start until user clicks.
- **VS Code binary size**: code-server is ~200MB. Pre-install in Docker image, not in home template.
- **Game quality**: Budget 2-3 days per game for polish. Ship fewer games at higher quality rather than more at lower quality.
- **App process leaks**: watchdog that kills orphaned processes. Health check that restarts crashed apps.
