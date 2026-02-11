# Module Standard

## What Is a Module?
A module is a self-contained application directory in `~/modules/` with its own manifest, entry point, and optional backend server.

## Required Files
- `manifest.json` -- metadata, port, health endpoint
- Entry point (usually `index.html` or `dist/index.html`)

## manifest.json Schema
```json
{
  "name": "string (kebab-case)",
  "version": "string (semver)",
  "description": "string",
  "entryPoint": "string (relative path)",
  "port": "number (3100-3999 range)",
  "health": "string (health check path, e.g. /health)",
  "dependencies": ["string[] (other module names)"],
  "data": "string (data directory path, optional)"
}
```

## Port Allocation
- Modules use ports 3100-3999
- Each module gets a unique port assigned at creation
- The gateway proxies `localhost:GATEWAY_PORT/modules/<name>/` to the module's port

## Health Checks
- Every module with a server MUST expose a health endpoint
- `GET /health` returns `200 OK` when healthy
- The heartbeat agent pings this every 30 seconds
- 3 consecutive failures trigger the healer agent

## Data Isolation
- Module data goes in `~/data/<module-name>/`
- Modules can read shared data from `~/data/shared/`
- Cross-module data flow: one module writes to `~/data/shared/`, another reads

## Registration
After creating a module, append to `~/system/modules.json`:
```json
{
  "name": "module-name",
  "type": "module",
  "path": "~/modules/module-name/",
  "port": 3100,
  "status": "running",
  "createdAt": "ISO timestamp"
}
```
