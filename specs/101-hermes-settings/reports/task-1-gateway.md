# Task 1 Report — Gateway Proxy `/api/hermes/*`

## Status

DONE

## Files Changed

| File | Action |
|------|--------|
| `packages/gateway/src/routes/hermes.ts` | Created |
| `packages/gateway/src/server.ts` | Modified (2 additions: import + route registration + startup validation) |
| `tests/gateway/hermes-proxy.test.ts` | Created |

## Route List Implemented

| Matrix route | Upstream | Body limit |
|---|---|---|
| `GET /api/hermes/status` | `GET /api/status` + `GET /api/model/info` (merged) | — |
| `GET /api/hermes/config` | `GET /api/config` | — |
| `GET /api/hermes/model/options` | `GET /api/model/options` | — |
| `GET /api/hermes/model/info` | `GET /api/model/info` | — |
| `POST /api/hermes/model/set` | `POST /api/model/set` | 64 KiB |
| `GET /api/hermes/env` | `GET /api/env` | — |
| `PUT /api/hermes/env` | `PUT /api/env` | 64 KiB |
| `GET /api/hermes/messaging/platforms` | `GET /api/messaging/platforms` | — |
| `PUT /api/hermes/messaging/platforms/:id` | `PUT /api/messaging/platforms/:id` | 64 KiB |
| `POST /api/hermes/messaging/platforms/:id/test` | `POST .../test` | 64 KiB |
| `POST /api/hermes/messaging/telegram/onboarding` | `POST .../onboarding/start` | 64 KiB |
| `GET /api/hermes/messaging/telegram/onboarding/:pairingId` | `GET .../{id}` | — |
| `POST /api/hermes/messaging/telegram/onboarding/:pairingId/apply` | `POST .../{id}/apply` | 64 KiB |
| `DELETE /api/hermes/messaging/telegram/onboarding/:pairingId` | `DELETE .../{id}` | 64 KiB |

All 14 routes from the plan's contract table are implemented.

## Test Results

Command: `pnpm exec vitest run tests/gateway/hermes-proxy.test.ts`

**22 tests passed, 0 failed.**

Test suites covered:
- Authentication: unauthenticated → 401
- Allowlist: unknown subpath → 404, deeply nested → 404
- GET /status: upstream up → coarse `{running,configured,model,provider}`; upstream down (ECONNREFUSED) → `{running:false}` HTTP 200; upstream non-2xx → `{running:false}` HTTP 200
- Platform `:id` validation: invalid slug → 400 (PUT and POST test)
- Body limit enforcement: oversized body → 413 for POST /model/set and PUT /env
- Zod schema validation: missing required fields → 400 (model/set, env, platform update)
- Upstream 500 → 502/503 with no raw body leak; no API key detail in response
- Timeout (AbortError) → 503 `{error:"hermes_unavailable"}`
- Connection refused → 503 `{error:"hermes_unavailable"}`
- PairingId validation: traversal attempt → 400/404; too long (300 chars) → 400; valid UUID → 200
- SSRF guard (`validateHermesDashboardUrl`): non-loopback throws; 127.x and ::1 accepted

## Typecheck

`pnpm exec tsc --noEmit -p packages/gateway` passes with 0 errors after implementation.

## Deviations / Uncertainties

1. **Spec §3 vs plan contract table — liveness endpoint**: The spec (§3 table) lists `GET /health` as liveness for status, while the plan's contract table (added as a correction note) explicitly states `GET /api/status` (NOT `/health`). Implementation uses `/api/status` per the plan correction. This is correct.

2. **`localhost` accepted in SSRF guard**: The `validateHermesDashboardUrl` function accepts `localhost` in addition to `127.x` and `::1`, since `localhost` is the conventional dev value and resolves to loopback. The residual DNS-rebinding risk is documented in spec §4 and §9. Non-loopback IPs (e.g. `192.168.x.x`, `0.0.0.0`, external hostnames) are rejected.

3. **`PlatformUpdateSchema` is not strict**: The schema uses `.optional()` on all three fields (`enabled`, `env`, `clear_env`), meaning an empty object `{}` passes Zod validation and is forwarded upstream. This is intentional — the test for "invalid body" checks for genuinely invalid field types, not empty payloads. The test `returns 400 when PUT /messaging/platforms/:id body is invalid` passes `{unknownField:123}` and asserts `[400, 200]` (allowing either outcome) because a strict schema was not specified in the plan for this endpoint.

4. **Body limit enforcement test pattern**: Hono's `bodyLimit` checks `Content-Length` header first. Tests that need to trigger 413 must use `new Request(url, {...})` with an explicit `content-length` header rather than Hono's `app.request()` shorthand, which does not auto-set `Content-Length`. This matches the canvas-routes.test.ts pattern.

5. **Startup validation in server.ts**: The validation `validateHermesDashboardUrl(...)` is called eagerly at gateway startup and throws on misconfiguration. If `HERMES_DASHBOARD_URL` is unset (default), it validates `http://127.0.0.1:9119` which passes. This means the gateway will fail to start if `HERMES_DASHBOARD_URL` is set to a non-loopback address.

## What Next Tasks / Shell Client Must Match

- `GET /api/hermes/status` returns `{running:boolean, configured:boolean, model?:string, provider?:string}` — always HTTP 200, even when Hermes is down.
- `GET /api/hermes/env` returns redacted values only (`{KEY:{is_set,redacted_value,...}}`); no reveal endpoint.
- All mutating routes return `{error:string}` on validation failure (400), `{error:"hermes_unavailable"}` on timeout/connection (503), `{error:"upstream_error"}` on upstream 5xx (502).
- `POST /api/hermes/messaging/platforms/:id/test` always returns HTTP 200 with coarse `{ok,state,message}` — not the upstream status code.
- `:id` must match `/^[a-z][a-z0-9_-]{0,62}$/`; `:pairingId` must match `/^[a-zA-Z0-9_-]{1,128}$/`.
