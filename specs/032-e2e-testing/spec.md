# 032: End-to-End Testing

## Problem

Matrix OS has 1,012 unit/integration tests across 86 files, but zero end-to-end tests. Unit tests mock dependencies (dispatcher, filesystem, kernel), which means integration bugs between layers go undetected. Coverage is 61.8% statements / 54% branches -- well below the 99% target. Critical user flows (chat via WebSocket, file operations, cron scheduling, auth gates) are only tested in isolation, never as real HTTP/WebSocket requests against a running gateway.

## Solution

A comprehensive E2E test suite that starts a real Hono gateway with a temp home directory and makes actual HTTP/WebSocket requests. Tests are organized in 3 tiers by value. The suite runs separately from unit tests via `bun run test:e2e` with its own Vitest config, and integrates into CI as a dedicated pipeline stage.

## Architecture

```
tests/e2e/
  fixtures/
    gateway.ts       # Starts real gateway on random port with temp home dir
    ws-client.ts     # WebSocket client helper (connect, send, waitFor)
  api/
    health.e2e.test.ts              # Smoke test (infra validation)
    chat-flow.e2e.test.ts           # T1: WebSocket chat roundtrip
    file-management.e2e.test.ts     # T1: File CRUD + path security
    cron-heartbeat.e2e.test.ts      # T1: Cron job management
    channel-routing.e2e.test.ts     # T1: Channel status + message API
    tasks.e2e.test.ts               # T2: Task CRUD
    settings-persistence.e2e.test.ts # T2: Layout/theme persistence
    identity.e2e.test.ts            # T2: Handle + profile endpoints
    conversations.e2e.test.ts       # T2: Conversation lifecycle
    push-notifications.e2e.test.ts  # T3: Push token registration
    auth-gates.e2e.test.ts          # T3: Auth middleware E2E
    security-headers.e2e.test.ts    # T3: Response header validation
    bridge-data.e2e.test.ts         # T3: App data bridge API
```

### Test Gateway Fixture

Each test suite starts its own gateway instance:

```typescript
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

let gw: TestGateway;
beforeAll(async () => { gw = await startTestGateway(); });
afterAll(async () => { await gw.close(); });
// gw.url  = "http://localhost:14001" (auto-incremented ports)
// gw.homePath = "/tmp/e2e-gateway-xxxxx" (temp dir with home/ template)
```

The fixture:
1. Creates a temp directory and copies the `home/` template into it
2. Initializes git (needed by dispatcher)
3. Creates required subdirectories (logs, conversations, plugins)
4. Starts a real Hono server on an auto-incremented port (14000+)
5. Returns `{ url, homePath, close }` for tests to use

Options:
- `authToken`: Sets `MATRIX_AUTH_TOKEN` for auth-gated tests
- `config`: Writes custom `system/config.json` (channels, heartbeat, plugins)

### WebSocket Client Fixture

```typescript
import { connectWs, type WsClient } from "../fixtures/ws-client.js";

const ws = await connectWs(gw.url.replace("http", "ws") + "/ws");
ws.send({ type: "message", text: "hello" });
const init = await ws.waitFor("kernel:init", 5000);
ws.close();
```

### No AI Calls Required

Tests use the real gateway but do NOT require `ANTHROPIC_API_KEY`. The dispatcher will attempt to call the kernel, which will fail without an API key. Tests verify:
- The error path works correctly (kernel:error messages)
- All HTTP endpoints return proper status codes and bodies
- WebSocket connection lifecycle is correct
- File system operations work end-to-end
- Auth middleware blocks/allows correctly

## Design: Test Tiers

### Tier 1: Critical Flows (highest value)

| Test | What It Validates |
|------|------------------|
| Chat flow | WS connect, message parsing, session switching, error handling |
| File management | PUT/GET/HEAD files, path traversal blocking, MIME types, nested dirs |
| Cron + heartbeat | CRUD cron jobs, schedule types (interval/cron/once), validation |
| Channel routing | Channel status endpoint, message dispatch, context passing |

### Tier 2: High-Value Workflows

| Test | What It Validates |
|------|------------------|
| Tasks | CRUD tasks, filtering by status, validation, task structure |
| Settings persistence | Layout save/load, theme retrieval, system info |
| Identity | Handle loading, profile/ai-profile endpoints |
| Conversations | Create/list/delete conversations, channel tagging |

### Tier 3: Medium-Value Flows

| Test | What It Validates |
|------|------------------|
| Push notifications | Token registration/removal, input validation |
| Auth gates | Token required for protected routes, public routes exempt |
| Security headers | X-Content-Type-Options, X-Frame-Options, CORS |
| Bridge data | App data read/write, key isolation, path sanitization |

## Configuration

### Vitest E2E Config (`vitest.e2e.config.ts`)

```typescript
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["node"],
    alias: { "@": path.resolve(__dirname, "shell/src") },
  },
  test: {
    globals: true,
    include: ["tests/e2e/**/*.e2e.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 20_000,
    sequence: { concurrent: false },
  },
});
```

Key differences from unit test config:
- 30s test timeout (vs default 5s) -- gateway startup + HTTP round-trips
- 20s hook timeout -- afterAll cleanup with server shutdown
- Sequential execution -- avoids port conflicts between test files
- Separate include pattern -- `*.e2e.test.ts` suffix

### Package.json Script

```json
{
  "scripts": {
    "test:e2e": "vitest run --config vitest.e2e.config.ts"
  }
}
```

## How to Run

```bash
# Run all E2E tests
bun run test:e2e

# Run a specific tier
bun run test:e2e -- --reporter=verbose tests/e2e/api/chat-flow.e2e.test.ts

# Run with watch mode
vitest --config vitest.e2e.config.ts

# Run unit + E2E together
bun run test && bun run test:e2e
```

## How to Add a New E2E Test

### 1. Create the test file

```bash
touch tests/e2e/api/my-feature.e2e.test.ts
```

### 2. Use the standard template

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: My Feature", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("does the thing", async () => {
    const res = await fetch(`${gw.url}/api/my-endpoint`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("expected");
  });
});
```

### 3. For WebSocket tests

```typescript
import { connectWs } from "../fixtures/ws-client.js";

it("handles WebSocket messages", async () => {
  const ws = await connectWs(gw.url.replace("http", "ws") + "/ws");
  ws.send({ type: "message", text: "test" });
  const msg = await ws.waitFor("kernel:init", 5000);
  expect(msg).toHaveProperty("sessionId");
  ws.close();
});
```

### 4. For auth-gated tests

```typescript
beforeAll(async () => {
  gw = await startTestGateway({ authToken: "test-secret" });
});

it("blocks unauthenticated requests", async () => {
  const res = await fetch(`${gw.url}/api/tasks`);
  expect(res.status).toBe(401);
});

it("allows authenticated requests", async () => {
  const res = await fetch(`${gw.url}/api/tasks`, {
    headers: { Authorization: "Bearer test-secret" },
  });
  expect(res.status).toBe(200);
});
```

### 5. For filesystem-dependent tests

```typescript
import { writeFileSync } from "node:fs";
import { join } from "node:path";

it("reads custom config", async () => {
  writeFileSync(
    join(gw.homePath, "system/theme.json"),
    JSON.stringify({ preset: "cyberpunk" }),
  );
  const res = await fetch(`${gw.url}/api/theme`);
  const body = await res.json();
  expect(body.preset).toBe("cyberpunk");
});
```

### 6. Verify

```bash
bun run test:e2e
```

All tests must pass. No test should depend on execution order of other test files.

## How to Verify E2E Tests Are Working

### Quick verification

```bash
# Should show all E2E test files discovered
vitest list --config vitest.e2e.config.ts

# Run with verbose output
bun run test:e2e -- --reporter=verbose
```

### Checklist for new E2E tests

- [ ] File is named `*.e2e.test.ts` and lives in `tests/e2e/`
- [ ] Uses `startTestGateway()` in `beforeAll` (not `beforeEach` -- gateway startup is expensive)
- [ ] Calls `gw.close()` in `afterAll` to free the port
- [ ] Uses real `fetch()` calls, not mocks
- [ ] Does not require `ANTHROPIC_API_KEY` or any external service
- [ ] Does not depend on other test files' state
- [ ] Cleans up WebSocket connections in `afterAll`
- [ ] Passes in isolation: `vitest run --config vitest.e2e.config.ts tests/e2e/api/my-test.e2e.test.ts`

## CI/CD Setup

### GitHub Actions Workflow (`.github/workflows/e2e.yml`)

```yaml
name: E2E Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: e2e-${{ github.ref }}
  cancel-in-progress: true

jobs:
  e2e:
    name: E2E Tests
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run E2E tests
        run: pnpm vitest run --config vitest.e2e.config.ts --reporter=verbose

      - name: Upload test results on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-test-results
          path: tests/e2e/
          retention-days: 7
```

### Integrating with Existing CI

If there is an existing workflow (e.g., `.github/workflows/ci.yml`), add E2E as a separate job that runs after unit tests:

```yaml
jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm vitest run

  e2e:
    name: E2E Tests
    needs: unit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm vitest run --config vitest.e2e.config.ts --reporter=verbose
```

### Branch Protection Rule

Add E2E as a required status check:
1. Go to **Settings > Branches > main > Edit**
2. Under "Require status checks", add `E2E Tests`
3. This prevents merging PRs with broken E2E tests

### Local Pre-Push Hook (optional)

Add to `.husky/pre-push` or run manually before pushing:

```bash
bun run test && bun run test:e2e
```

## Port Allocation

E2E tests use auto-incremented ports starting at 14000 to avoid conflicts with:
- Development gateway (4000)
- Development shell (3000)
- Platform service (9000)
- Module ports (3100-3999)

Each `startTestGateway()` call gets the next available port. Tests run sequentially so port reuse is not an issue within a single Vitest run.

## Relationship to Other Test Types

| Type | Config | Command | What | Speed |
|------|--------|---------|------|-------|
| Unit | `vitest.config.ts` | `bun run test` | Isolated functions, mocked deps | ~12s |
| Integration | `vitest.integration.config.ts` | `bun run test:integration` | Real AI calls (haiku) | ~60s |
| **E2E** | `vitest.e2e.config.ts` | `bun run test:e2e` | Real HTTP/WS against gateway | ~15-30s |

Unit tests run on every save (watch mode). E2E tests run on CI and before PRs. Integration tests run on-demand (require API key).

## Future Extensions

- **Browser E2E** (`tests/e2e/browser/`): Playwright tests against the Next.js shell, testing real UI interactions (chat typing, command palette, settings UI, window management)
- **Multi-client E2E**: Two WebSocket clients connected simultaneously, verify broadcast behavior
- **Channel adapter E2E**: Mock Telegram/Discord webhook endpoints, verify full message round-trip
- **Performance E2E**: Response time assertions, concurrent request handling
- **Docker E2E**: Spin up the full Docker container, test against it
