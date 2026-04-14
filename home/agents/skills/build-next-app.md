---
name: build-next-app
description: Build a Next.js app for Matrix OS with API routes, SSR, and the basePath convention
trigger: When the user asks to build a server-side app, an app with API routes, or a Next.js app
---

# Build a Next.js App

## When to use Next.js (runtime: "node")

Use Next.js when the app needs:
- API routes (e.g., /api/data, /api/webhooks)
- Server-side rendering (SSR) or React Server Components
- Background processing or long-lived connections
- Database access from server code

For static React SPAs without server logic, use the Vite template instead (see `build-vite-app.md`).

## Scaffold

```bash
cp -r ~/apps/_template-next ~/apps/{slug}
```

Edit `matrix.json`:
```json
{
  "name": "My App Name",
  "slug": "my-app-slug",
  "version": "1.0.0",
  "runtime": "node",
  "runtimeVersion": "^1.0.0",
  "build": {
    "command": "next build",
    "output": ".next"
  },
  "serve": {
    "start": "next start -p $PORT",
    "healthCheck": "/api/health",
    "startTimeout": 15,
    "idleShutdown": 300
  }
}
```

## Critical: basePath

Every Next.js app MUST set `basePath` in `next.config.ts`:

```typescript
const config: NextConfig = {
  basePath: `/apps/${process.env.MATRIX_APP_SLUG}`,
};
```

Without this, asset URLs and navigation links will break because the app is served under `/apps/{slug}/`, not `/`.

## API Routes

Create API routes in `app/api/`:

```typescript
// app/api/health/route.ts (required for health checks)
import { NextResponse } from "next/server";
export function GET() {
  return NextResponse.json({ ok: true });
}
```

```typescript
// app/api/data/route.ts
import { NextResponse } from "next/server";
export async function GET() {
  // Access per-app data directory
  const dataDir = process.env.MATRIX_APP_DATA_DIR;
  return NextResponse.json({ items: [] });
}
```

## Environment Variables

The gateway provides these env vars to every child process:
- `PORT` - the port to listen on (do NOT hardcode a port)
- `NODE_ENV` - always "production"
- `MATRIX_APP_SLUG` - the app slug
- `MATRIX_APP_DATA_DIR` - path to per-app persistent data
- `MATRIX_GATEWAY_URL` - gateway URL for kernel API calls

## Build and Test

```bash
cd ~/apps/{slug}
pnpm install
pnpm build
# The gateway will start the app automatically when opened in AppViewer
```

## Resource Limits

Default limits per app:
- 256 MB memory (--max-old-space-size injected automatically)
- Idle shutdown after 300 seconds of no requests
- Maximum 10 concurrent node apps across the gateway
