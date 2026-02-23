# Tasks: E2E Testing

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T1100-T1119

## User Stories

- **US40**: "I can trust that the gateway handles real HTTP requests correctly before deploying"
- **US41**: "PR authors can see if their changes break critical user flows"
- **US42**: "New contributors can add E2E tests following a clear template"
- **US43**: "CI catches integration bugs that unit tests miss"

---

## Phase A: Infrastructure (T1100-T1102) -- COMPLETE

### T1100 [US42] E2E Vitest config
- [x] `vitest.e2e.config.ts` with 30s timeout, sequential execution
- [x] `bun run test:e2e` script in root package.json
- [x] Separate include pattern: `tests/e2e/**/*.e2e.test.ts`
- **Output**: E2E tests discoverable and runnable independently

### T1101 [US42] Gateway test fixture
- [x] `tests/e2e/fixtures/gateway.ts`: starts real Hono gateway on auto-incremented port
- [x] Copies `home/` template to temp dir, inits git
- [x] Supports `authToken` and `config` options
- [x] Returns `{ url, homePath, close }` for test use
- **Output**: One-line gateway setup for any E2E test

### T1102 [US42] WebSocket client fixture
- [x] `tests/e2e/fixtures/ws-client.ts`: connect, send, waitFor, messages, close
- [x] Promise-based `waitFor(type, timeout)` for async message matching
- **Output**: Clean WS testing API

---

## Phase B: Tier 1 -- Critical Flows (T1103-T1106)

### T1103 [US40] Chat flow E2E
- [ ] WebSocket connect to `/ws`
- [ ] Send message, verify `kernel:init` or `kernel:error` response
- [ ] Session switching via `switch_session` message
- [ ] Invalid JSON handling
- [ ] Multiple concurrent connections
- **Output**: `tests/e2e/api/chat-flow.e2e.test.ts` (8-12 tests)

### T1104 [US40] File management E2E
- [ ] PUT/GET/HEAD file operations
- [ ] Nested directory creation
- [ ] Path traversal blocked (403)
- [ ] Directory access blocked (400)
- [ ] MIME type handling (json, html, md, txt)
- [ ] Nonexistent file returns 404
- **Output**: `tests/e2e/api/file-management.e2e.test.ts` (8-12 tests)

### T1105 [US40] Cron + heartbeat E2E
- [ ] POST /api/cron with interval/cron/once schedules
- [ ] GET /api/cron lists all jobs
- [ ] DELETE /api/cron/:id removes job
- [ ] Validation: missing fields return 400
- [ ] Invalid schedule types rejected
- **Output**: `tests/e2e/api/cron-heartbeat.e2e.test.ts` (8-12 tests)

### T1106 [US40] Channel routing E2E
- [ ] GET /api/channels/status returns status object
- [ ] POST /api/message triggers dispatch
- [ ] Session ID and context passing
- [ ] Error handling without API key
- **Output**: `tests/e2e/api/channel-routing.e2e.test.ts` (6-8 tests)

---

## Phase C: Tier 2 -- High-Value Workflows (T1107-T1110)

### T1107 [US40] Task management E2E
- [ ] POST /api/tasks creates tasks with id
- [ ] GET /api/tasks lists all, supports status filter
- [ ] GET /api/tasks/:id returns specific task
- [ ] 404 for nonexistent task
- [ ] 400 for missing input
- [ ] Task structure validation (id, type, status, input)
- **Output**: `tests/e2e/api/tasks.e2e.test.ts` (6-10 tests)

### T1108 [US40] Settings persistence E2E
- [ ] GET/PUT /api/layout round-trip
- [ ] Layout validation (requires windows array)
- [ ] GET /api/theme reads from filesystem
- [ ] GET /api/apps returns app list
- [ ] GET /api/system/info returns info object
- **Output**: `tests/e2e/api/settings-persistence.e2e.test.ts` (6-10 tests)

### T1109 [US40] Identity E2E
- [ ] GET /api/identity returns handle from template
- [ ] GET /api/profile returns profile markdown
- [ ] GET /api/ai-profile returns AI profile markdown
- [ ] Custom handle.json reflected in API
- **Output**: `tests/e2e/api/identity.e2e.test.ts` (4-6 tests)

### T1110 [US40] Conversations E2E
- [ ] POST /api/conversations creates conversation
- [ ] GET /api/conversations lists all
- [ ] DELETE /api/conversations/:id removes
- [ ] Channel tagging on creation
- [ ] 404 for nonexistent delete
- **Output**: `tests/e2e/api/conversations.e2e.test.ts` (6-8 tests)

---

## Phase D: Tier 3 -- Medium-Value Flows (T1111-T1114)

### T1111 [US40] Push notifications E2E
- [ ] POST /api/push/register with token + platform
- [ ] DELETE /api/push/register removes token
- [ ] Validation: missing token/platform returns 400
- **Output**: `tests/e2e/api/push-notifications.e2e.test.ts` (6 tests)

### T1112 [US41] Auth gates E2E
- [ ] Gateway started with authToken
- [ ] /health public (no token needed)
- [ ] Protected routes return 401 without token
- [ ] Protected routes return 401 with wrong token
- [ ] Protected routes return 200 with correct token
- **Output**: `tests/e2e/api/auth-gates.e2e.test.ts` (6-8 tests)

### T1113 [US41] Security headers E2E
- [ ] X-Content-Type-Options: nosniff on all responses
- [ ] X-Frame-Options: DENY on all responses
- [ ] X-XSS-Protection header present
- [ ] CORS headers present
- **Output**: `tests/e2e/api/security-headers.e2e.test.ts` (4-6 tests)

### T1114 [US40] Bridge data E2E
- [ ] Write then read app data
- [ ] Read nonexistent key returns null
- [ ] Overwrite existing key
- [ ] Path sanitization on app name
- [ ] Data persisted to filesystem
- **Output**: `tests/e2e/api/bridge-data.e2e.test.ts` (6-8 tests)

---

## Phase E: CI/CD (T1115-T1119)

### T1115 [US43] GitHub Actions E2E workflow
- [ ] `.github/workflows/e2e.yml` runs on push to main + PRs
- [ ] Installs Node 22 + pnpm, runs `pnpm vitest run --config vitest.e2e.config.ts`
- [ ] Uploads test results as artifact on failure
- [ ] Concurrency: cancel in-progress runs on same branch
- [ ] 10-minute timeout
- **Output**: E2E tests run automatically on every PR

### T1116 [US43] Branch protection integration
- [ ] Add "E2E Tests" as required status check on main
- [ ] PRs cannot merge with failing E2E tests
- **Output**: E2E tests gate deployment

### T1117 [US43] Integration with existing CI
- [ ] E2E job runs after unit tests pass (dependency chain)
- [ ] Separate job for clear failure attribution
- **Output**: Clean CI pipeline: unit -> E2E -> deploy

### T1118 [US42] E2E test template documentation
- [ ] Spec covers how to add new tests (template, checklist)
- [ ] Fixture API documented with examples
- [ ] Port allocation strategy documented
- **Output**: Self-service E2E test creation

### T1119 [US43] E2E smoke test
- [x] `tests/e2e/api/health.e2e.test.ts` validates infrastructure works
- [x] Gateway starts, health endpoint returns 200
- **Output**: Canary test that catches broken fixtures
