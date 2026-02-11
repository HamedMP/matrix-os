# Matrix OS -- Technical Decisions

## Stack

| Choice | Technology | Reasoning |
|--------|-----------|-----------|
| Language | TypeScript (strict, ESM) | Type safety for module interfaces, our expertise |
| Runtime | Node.js | Native TypeScript ecosystem, child_process for module mgmt |
| AI | Claude API (Opus 4.6) | Hackathon requirement; best reasoning for architecture + code gen |
| Database | SQLite (better-sqlite3) | Zero config, embeddable, perfect for module registry + generated modules |
| Web Framework | Hono | Lightweight, fast, works great for both dashboard and generated APIs |
| Frontend | React (or plain HTML + htmx for speed) | Dashboard needs interactivity; htmx is faster to build |
| Graph Viz | D3.js or vis-network | Module graph visualization |
| Bundler | esbuild | Fastest TS bundler, good for validating generated modules |
| Process Mgmt | Node child_process + pidfile | Simple, native, reliable |

## Key Design Decisions

### Why SQLite over files for registry?

- Atomic operations (no partial writes)
- Query by type, status, dependencies
- Shared access from dashboard and CLI
- Still zero-config, no external service

### Why Hono over Next.js for dashboard?

- Lighter weight, faster to stand up
- Can serve both API and static files
- No build step needed (important for hackathon speed)
- If we need more interactivity, can add React on top

### Why child_process over Docker for modules?

- Zero setup required (Docker adds complexity)
- Faster start/stop
- Easier log capture and health monitoring
- Good enough for demo scope
- Docker could be a stretch goal

### How modules share data

Primary mechanism: **shared SQLite databases.**

When the Builder creates related modules, it:
1. Creates a shared database file in a known location
2. Injects the database path as an environment variable
3. Each module imports better-sqlite3 and uses the shared db

This is the simplest approach that works for the demo. More sophisticated approaches (HTTP APIs between modules, event bus) are stretch goals.

### Module generation strategy

Opus 4.6 receives:
- The user's natural language request
- The current module registry (what exists)
- The module standard (manifest schema, directory structure)
- Code style guidelines

It outputs:
- A structured response with manifest + file contents
- Using tool use / structured output for reliability

We do NOT use a template system. Every module is generated from scratch by Opus 4.6. This is the core differentiator -- the AI is the architect and builder.

For reliability, we:
- Validate manifest schema before writing
- Run generated tests
- Type-check generated code (if time permits)
- Have a retry loop: if tests fail, feed errors back to Opus 4.6 for a fix

### Project directory structure

```
matrix-os/
  specs/                  # planning docs (this folder)
  src/
    core/
      engine.ts           # main orchestrator
      builder.ts          # Builder agent (Opus 4.6 code gen)
      healer.ts           # Healer agent (monitoring + repair)
      composer.ts          # module wiring and composition
    registry/
      registry.ts         # module registry (SQLite)
      schema.ts           # manifest types and validation
    runtime/
      runtime.ts          # process management
      health.ts           # health check loop
      ports.ts            # port allocation
    cli/
      index.ts            # CLI entry point
      commands.ts         # CLI command handlers
    dashboard/
      server.ts           # Hono web server
      routes/             # API routes
      static/             # HTML/CSS/JS for dashboard
    shared/
      types.ts            # shared TypeScript types
      config.ts           # configuration
      logger.ts           # logging utility
  modules/                # generated modules live here
  data/                   # SQLite databases
  package.json
  tsconfig.json
```

## AI Prompt Architecture

### Builder System Prompt (summary)

The Builder agent receives a system prompt that:
1. Defines the module standard (manifest schema, types, structure)
2. Explains available module types and when to use each
3. Lists all existing modules and their interfaces
4. Instructs structured output format
5. Emphasizes: working code > perfect code, include tests, use TypeScript

### Healer System Prompt (summary)

The Healer agent receives:
1. The failing module's manifest, source code, and recent logs
2. Error messages and stack traces
3. Related modules and their status
4. Instructions: diagnose root cause, generate minimal patch, explain reasoning

### Tool Use Pattern

Use Claude's tool use for structured output:

```typescript
// Builder tool definition
{
  name: "create_module",
  description: "Create a new module for Matrix OS",
  input_schema: {
    type: "object",
    properties: {
      manifest: { /* manifest schema */ },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" }
          }
        }
      }
    }
  }
}
```

This ensures we get structured, parseable output from Opus 4.6 rather than hoping for consistent markdown/text formatting.
