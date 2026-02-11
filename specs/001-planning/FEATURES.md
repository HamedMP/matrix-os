# Matrix OS -- Features

## Priority Tiers

### P0 -- Must Have (Demo Critical)

These features must work for the hackathon demo.

#### Module Generation
- Natural language input → working module
- Support at minimum: `web`, `cli`, `lib` module types
- Generated code includes basic tests
- Modules are registered and runnable immediately

#### Module Standard
- Consistent manifest.json schema across all module types
- Standard directory structure
- Clear interface definitions (what a module provides/depends on)

#### Module Runtime
- Start/stop modules as child processes
- Port allocation for web modules
- Basic log capture
- Process health monitoring (is it running? is it responding?)

#### Module Composition
- Modules can depend on other modules
- Shared data stores between related modules
- Service discovery (find module X's port/endpoint)

#### Self-Healing (Basic)
- Health check loop detecting failed modules
- Error capture and diagnosis via Opus 4.6
- Auto-generate patch and apply
- Show the healing process in logs/dashboard

#### Web Dashboard
- Module graph visualization (nodes = modules, edges = connections)
- Real-time status indicators
- Natural language input bar for building new modules
- Activity log showing builds, heals, status changes

#### CLI Interface
- `matrix-os "natural language request"` for building
- `matrix-os status` for system overview
- `matrix-os list` for listing modules

### P1 -- Should Have (Polish)

These significantly improve the demo but aren't blockers.

#### Intelligent Module Planning
- Before building, show the user a plan: "I'll create X, connect it to Y, using Z"
- User can approve, modify, or reject before generation starts

#### Module Evolution
- Modify existing modules via natural language
- "Add category filtering to the expense dashboard"
- Opus 4.6 reads existing code, makes targeted changes, re-tests

#### Architecture Visualization
- Animated module graph that grows as new modules are added
- Show data flow between modules
- Highlight healing events in real-time

#### Multi-step Builds
- Complex requests decomposed into multiple modules automatically
- "Build me a blog with an admin panel and RSS feed"
  → generates web module, admin module, rss module, content-db module

### P2 -- Nice to Have (Stretch Goals)

These would elevate the project but only if time permits.

#### Module Marketplace / Templates
- Pre-built module templates for common patterns
- Share modules between Matrix OS instances

#### Persistent Chat Context
- Conversational interface that remembers previous requests
- "Make the chart from earlier use a bar chart instead"

#### Event Bus
- Real-time pub/sub between modules
- Modules can react to events from other modules

#### Deploy to Cloud
- Package the entire system for deployment
- Export as Docker Compose or similar

#### Module Versioning
- Track module versions over time
- Rollback to previous versions if healing fails

## Feature Details

### Module Generation Flow

```
User: "I need a web app to track my reading list"
                    │
                    ▼
          ┌─────────────────┐
          │  Analyze Request │
          │                 │
          │  - What type?   │
          │  - Existing     │
          │    modules?     │
          │  - Data needs?  │
          └────────┬────────┘
                    │
                    ▼
          ┌─────────────────┐
          │  Plan & Present │  (P1: show user before building)
          │                 │
          │  "I'll create:  │
          │   - reading-db  │
          │   - reading-web │
          │   Connected via │
          │   shared SQLite"│
          └────────┬────────┘
                    │
                    ▼
          ┌─────────────────┐
          │  Generate Code  │
          │                 │
          │  Opus 4.6:      │
          │  - manifest     │
          │  - source code  │
          │  - tests        │
          └────────┬────────┘
                    │
                    ▼
          ┌─────────────────┐
          │  Validate       │
          │                 │
          │  - Run tests    │
          │  - Type check   │
          │  - Health check │
          └────────┬────────┘
                    │
                    ▼
          ┌─────────────────┐
          │  Register & Run │
          │                 │
          │  - Add to       │
          │    registry     │
          │  - Wire deps    │
          │  - Start process│
          └─────────────────┘
```

### Self-Healing Flow

```
Health Check Loop (every 30s)
          │
          ▼
   Module responding? ──yes──► All good
          │
          no
          │
          ▼
   ┌─────────────────┐
   │  Collect Context │
   │                 │
   │  - Error logs   │
   │  - Recent       │
   │    changes      │
   │  - Dependencies │
   │    status       │
   └────────┬────────┘
            │
            ▼
   ┌─────────────────┐
   │  Diagnose       │
   │  (Opus 4.6)     │
   │                 │
   │  Reads all      │
   │  context,       │
   │  identifies     │
   │  root cause     │
   └────────┬────────┘
            │
            ▼
   ┌─────────────────┐
   │  Generate Patch │
   │  (Opus 4.6)     │
   │                 │
   │  Writes fix,    │
   │  runs tests     │
   └────────┬────────┘
            │
            ▼
      Tests pass? ──no──► Flag for manual review
            │
           yes
            │
            ▼
   ┌─────────────────┐
   │  Apply & Restart│
   │                 │
   │  Deploy fix,    │
   │  restart module,│
   │  verify health  │
   └─────────────────┘
```

### Dashboard Features

Main views:

1. **System Overview**
   - Module count, health summary, uptime
   - Natural language input bar (prominent)
   - Recent activity feed

2. **Module Graph**
   - Interactive node graph (d3 or similar)
   - Nodes = modules (colored by type)
   - Edges = dependencies/data flow
   - Click node for detail panel

3. **Module Detail**
   - Status, health history
   - Source code viewer
   - Logs (stdout/stderr)
   - Manifest and interfaces
   - Actions: restart, heal, remove, evolve

4. **Build Log**
   - Chronological list of all build/heal events
   - Expandable: shows Opus 4.6 reasoning, generated code, test results

5. **Health Monitor**
   - All modules with traffic-light status
   - Healing history
   - Current healing operations in progress
