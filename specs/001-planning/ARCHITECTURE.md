# Matrix OS -- Architecture

## System Overview

```
┌──────────────────────────────────────────────────────┐
│                   Interface Layer                      │
│         CLI   |   Web Dashboard   |   Chat            │
├──────────────────────────────────────────────────────┤
│                    Core Engine                         │
│  ┌────────────┐ ┌──────────┐ ┌─────────────────────┐ │
│  │  Builder    │ │  Healer  │ │     Composer         │ │
│  │            │ │          │ │                     │ │
│  │ Architects │ │ Monitors │ │ Wires modules       │ │
│  │ & generates│ │ & patches│ │ together, manages   │ │
│  │ modules    │ │ failures │ │ data flow           │ │
│  └────────────┘ └──────────┘ └─────────────────────┘ │
├──────────────────────────────────────────────────────┤
│                  Module Registry                      │
│                                                      │
│  Tracks all installed modules, their capabilities,   │
│  dependencies, health status, and connections        │
├──────────────────────────────────────────────────────┤
│                  Module Runtime                       │
│                                                      │
│  Runs modules as processes, serves web modules,      │
│  manages lifecycle (start/stop/restart)              │
├──────────────────────────────────────────────────────┤
│              Module Layer (LEGO Pieces)               │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐      │
│  │ web  │ │ cli  │ │ api  │ │ cron │ │ lib  │ ...  │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘      │
└──────────────────────────────────────────────────────┘
```

## Core Components

### 1. Module Standard

Every module follows a standard structure:

```
modules/<module-name>/
  manifest.json      # metadata, type, dependencies, exposed interfaces
  src/               # generated source code
  tests/             # auto-generated tests
  README.md          # auto-generated docs
```

**manifest.json schema:**

```json
{
  "name": "expense-tracker-web",
  "type": "web",
  "version": "1.0.0",
  "description": "Web dashboard for tracking daily expenses",
  "created": "2026-02-10T18:00:00Z",
  "provides": [
    { "name": "expense-api", "type": "http", "port": 3001 }
  ],
  "depends": [
    { "module": "expense-db", "interface": "data-store" }
  ],
  "health": {
    "endpoint": "/health",
    "interval": 30
  }
}
```

**Module types:**

| Type | What it is | How it runs |
|------|-----------|-------------|
| `web` | Web application (frontend + backend) | HTTP server on assigned port |
| `cli` | Command-line tool | Executable, registered in PATH |
| `api` | Standalone API/service | HTTP server on assigned port |
| `cron` | Scheduled task | Triggered by internal scheduler |
| `lib` | Shared library/utility | Imported by other modules |

### 2. Core Engine

#### Builder Agent

The brain of module creation. When a user describes what they need:

1. **Analyze** -- understand the request, identify what modules already exist
2. **Architect** -- decide module type, data models, interfaces, dependencies
3. **Generate** -- write the code using Opus 4.6
4. **Test** -- run generated tests to verify
5. **Register** -- add to module registry
6. **Start** -- launch the module

Key decisions the Builder makes:
- Should this be a new module or an extension of an existing one?
- What type of module fits best?
- What existing modules should it connect to?
- What data models and interfaces does it need?

#### Healer Agent

Monitors system health and auto-repairs:

1. **Monitor** -- health checks on all running modules
2. **Detect** -- catch errors, crashes, unexpected behavior
3. **Diagnose** -- use Opus 4.6 to read error logs, trace root cause
4. **Patch** -- generate a fix, run tests
5. **Deploy** -- apply the patch, restart the module
6. **Report** -- log what happened and what was fixed

#### Composer

Manages inter-module connections:

- Maintains a dependency graph
- Routes data between modules
- Handles service discovery (which module is on which port)
- Manages shared resources (databases, config)

### 3. Module Registry

A local data store (SQLite or JSON file) tracking:

- All registered modules and their manifests
- Module status (running, stopped, error, healing)
- Dependency graph
- Health history
- Connection map

### 4. Module Runtime

Responsible for actually running modules:

- Process management (spawn, monitor, restart)
- Port allocation for web/api modules
- Log collection
- Environment variable injection
- Graceful shutdown

### 5. Interface Layer

#### CLI Interface
```
matrix-os "I need a tool that..."    # natural language builder
matrix-os list                       # show all modules
matrix-os status                     # system health overview
matrix-os logs <module>              # view module logs
matrix-os heal <module>              # trigger manual healing
matrix-os remove <module>            # remove a module
```

#### Web Dashboard
- System overview with module graph visualization
- Real-time status of all modules
- Build/heal activity log
- Natural language input for building new modules
- Module detail views with code, logs, health

## Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Language | TypeScript (strict) | Type safety, user's expertise |
| Runtime | Node.js | Native for TypeScript, good process management |
| AI Engine | Claude API (Opus 4.6) | Hackathon requirement, best reasoning model |
| Web Framework | Next.js or Hono | Dashboard UI + API |
| Data Store | SQLite (better-sqlite3) | Zero config, embedded, good enough |
| Process Mgmt | Node child_process | Native, simple, sufficient |
| Module Bundling | esbuild | Fast, handles TypeScript |

## Data Flow Example

User says: "I want a CLI tool to log expenses"

```
User Input
  │
  ▼
Core Engine (analyzes request)
  │
  ├─► Registry: "Do we have expense-related modules?"
  │   └─► Yes: expense-db (lib), expense-web (web)
  │
  ├─► Builder: "Create CLI module, connect to expense-db"
  │   │
  │   ├─► Opus 4.6: generates CLI code
  │   ├─► Opus 4.6: generates tests
  │   ├─► Runtime: runs tests ✓
  │   ├─► Registry: register new module
  │   └─► Composer: wire to expense-db
  │
  └─► Runtime: start module
      └─► "expense-cli" is now available
```

## Module Communication

Modules communicate through:

1. **Shared SQLite databases** -- for data modules (simplest)
2. **HTTP APIs** -- for service-to-service calls
3. **File system** -- for shared config and assets
4. **Event bus** -- lightweight pub/sub for real-time updates (stretch goal)
