# Hermes Settings Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). Spec of record: `specs/101-hermes-settings/spec.md`. Build chat is OUT OF SCOPE (deferred to 061).

**Goal:** A real Hermes settings surface (Overview / Providers / Models / Channels) wired to the Hermes **dashboard** API via a guarded gateway proxy, mounted both as Settings → Hermes and as an in-chat overlay; plus the VPS service that serves the dashboard. Retire the cosmetic `ChatApp` Hermes stub.

**Architecture:** 3 layers — (1) VPS `matrix-hermes-dashboard` systemd service running `hermes dashboard --host 127.0.0.1 --port 9119`; (2) gateway `/api/hermes/*` allowlist proxy (auth = matrix principal; upstream is loopback, ungated); (3) shell `HermesSettings` shared component + typed `hermes-client.ts`.

**Tech Stack:** Hono (gateway), Zod 4 (`zod/v4`), React 19 + shell conventions, Vitest, node fetch with `AbortSignal.timeout`.

## Global Constraints

- **Auth:** every `/api/hermes/*` route requires `requireRequestPrincipal(c)` (`packages/gateway/src/request-principal.js`). Upstream Hermes is loopback + ungated; matrix auth is the only gate. Browser never talks to :9119.
- **Upstream base URL:** `HERMES_DASHBOARD_URL`, default `http://127.0.0.1:9119`. Validate it resolves to loopback at startup; `redirect: "error"` on every fetch.
- **Timeouts:** `AbortSignal.timeout(10_000)` on every proxied fetch.
- **Errors:** never forward raw upstream/provider bodies. Log real error server-side; return generic. Hermes unreachable → `503 { error: "hermes_unavailable" }`. Test/status endpoints return coarse booleans/states only.
- **Input validation:** `bodyLimit` on every mutating route incl. DELETE; validate `:id` against `SAFE_SLUG`; per-endpoint Zod body schemas; validate `:pairingId` shape.
- **Allowlist only** — no arbitrary pass-through. Unknown subpath → 404.
- **No new matrix persistence** — stateless proxy. Hermes owns `~/.hermes/config.yaml` + `.env`; matrix never writes those files directly.
- **Secrets:** API keys write-only from UI; `GET /api/hermes/env` returns redacted only; reveal is out of scope.
- No emojis in code. Conventional commits, no co-authored-by. Commit per task locally (no push) on this branch.
- **react-doctor** must pass for any `.tsx` change before commit (`npx react-doctor@latest shell`).

## Hermes dashboard API contract (verified against `../hermes-agent/hermes_cli/web_server.py`)

> Correction to spec 101: liveness is **`GET /api/status`**, NOT `/health` (the dashboard has no `/health`). `/api/model/info` and `/api/status` are public (bypass auth) on loopback.

| matrix route | upstream (`:9119`) | req | resp (subset) |
|---|---|---|---|
| `GET /api/hermes/status` | `GET /api/status` | — | `{version, gateway_running, gateway_state, gateway_platforms, active_sessions}` → map to coarse `{running, configured, model?, provider?}` (merge `GET /api/model/info`) |
| `GET /api/hermes/config` | `GET /api/config` | — | config dict (model flattened) |
| `GET /api/hermes/model/options` | `GET /api/model/options` | — | `{providers:[{slug,models[],authenticated,auth_type,key_env,capabilities,unavailable_models,free_tier,warning}], model, provider}` |
| `GET /api/hermes/model/info` | `GET /api/model/info` | — | `{model,provider,effective_context_length,capabilities{supports_tools,supports_vision,supports_reasoning,context_window,max_output_tokens,model_family}}` |
| `POST /api/hermes/model/set` | `POST /api/model/set` | `{scope:"main"\|"auxiliary",provider,model,task?,base_url?}` | `{ok,scope,provider,model,base_url,stale_aux?}` |
| `GET /api/hermes/env` | `GET /api/env` | — | `{KEY:{is_set,redacted_value,description,url,category,is_password,advanced,channel_managed}}` |
| `PUT /api/hermes/env` | `PUT /api/env` | `{key,value}` | `{ok,key}` |
| `GET /api/hermes/messaging/platforms` | `GET /api/messaging/platforms` | — | `{platforms:[{id,name,description,docs_url,enabled,configured,gateway_running,state,error_code,error_message,home_channel,env_vars:[{key,required,is_set,redacted_value}]}]}` |
| `PUT /api/hermes/messaging/platforms/:id` | `PUT /api/messaging/platforms/:id` | `{enabled?,env?:{},clear_env?:[]}` | `{ok,platform}` |
| `POST /api/hermes/messaging/platforms/:id/test` | `POST .../:id/test` | — | `{ok,state,message}` (coarse) |
| `POST /api/hermes/messaging/telegram/onboarding` | `POST .../telegram/onboarding/start` | `{bot_name?}` | `{pairing_id,suggested_username,deep_link,qr_payload,expires_at}` |
| `GET /api/hermes/messaging/telegram/onboarding/:pairingId` | `GET .../{id}` | — | `{status:"waiting"\|"ready",bot_username?,owner_user_id?,expires_at}` |
| `POST /api/hermes/messaging/telegram/onboarding/:pairingId/apply` | `POST .../{id}/apply` | `{allowed_user_ids:[str]}` | `{ok,platform,bot_username,needs_restart}` |
| `DELETE /api/hermes/messaging/telegram/onboarding/:pairingId` | `DELETE .../{id}` | — | `{ok}` |

UI patterns to mirror from finna-cloud (`apps/web/src/components/gateway/{models-page,channels-section}.tsx`): Providers/Models tabs; provider cards with configured check + "Add/Replace API Key" dialog; model cards grouped by provider with Active badge + vision/reasoning icons; channels as expandable cards with a status pill (connected=green, configured=blue, error=red, disabled=muted). Use Matrix shell component conventions, not finna's shadcn imports.

---

## Task 1: Gateway proxy `/api/hermes/*`

**Files:**
- Create: `packages/gateway/src/routes/hermes.ts`
- Modify: `packages/gateway/src/server.ts` (mount `registerHermesRoutes(app, ...)`)
- Test: `tests/gateway/hermes-proxy.test.ts`

**Interfaces:**
- Produces: `registerHermesRoutes(app, deps)` mounting the allowlisted routes above under `/api/hermes`. Reads upstream base from `HERMES_DASHBOARD_URL` (default `http://127.0.0.1:9119`). A `hermesFetch(path, init)` helper: injects `AbortSignal.timeout(10_000)`, `redirect:"error"`, maps connection errors → `503 {error:"hermes_unavailable"}`, never leaks upstream bodies.

- [ ] **Step 1: Tests first** (`tests/gateway/hermes-proxy.test.ts`), mocking `fetch`/upstream:
  - unauthenticated request → 401 (principal required).
  - unknown subpath (`/api/hermes/bogus`) → 404 (allowlist).
  - `GET /api/hermes/status` maps upstream `/api/status`(+`/api/model/info`) → coarse `{running,configured,model,provider}`; upstream down → `{running:false}` (200, not 503, for status).
  - mutating routes: `:id` not matching `SAFE_SLUG` → 400; body over limit → 413; missing body fields → 400 (Zod).
  - upstream 500 → generic 502/503, raw body NOT present in response.
  - timeout (mock abort) → 503 `hermes_unavailable`.
- [ ] **Step 2: Run, verify red.** `pnpm exec vitest run tests/gateway/hermes-proxy.test.ts`
- [ ] **Step 3: Implement** `routes/hermes.ts` per the contract table + Global Constraints; mount in `server.ts` near other `/api/*` route registrations.
- [ ] **Step 4: Run, verify green.** Same vitest command.
- [ ] **Step 5: typecheck** `bun run typecheck` (or `pnpm exec tsc --noEmit -p packages/gateway`).
- [ ] **Step 6: Stage & await go-ahead.** `git add packages/gateway/src/routes/hermes.ts packages/gateway/src/server.ts tests/gateway/hermes-proxy.test.ts`

---

## Task 2: Shell typed client `hermes-client.ts`

**Files:**
- Create: `shell/src/lib/hermes-client.ts`
- Test: `shell/src/lib/hermes-client.test.ts` (or `tests/shell/`)

**Interfaces:**
- Produces: typed functions `getHermesStatus()`, `getModelOptions()`, `getModelInfo()`, `setModel(body)`, `getEnv()`, `setEnv(key,value)`, `listPlatforms()`, `updatePlatform(id,body)`, `testPlatform(id)`, telegram onboarding `start/poll/apply/cancel`. Each hits `/api/hermes/*`, uses `AbortSignal.timeout`, normalizes errors to a generic shape (allowlist/cap error strings per CLAUDE.md), returns typed subset objects (defined as interfaces in this file).

- [ ] **Step 1: Tests first** — request shaping (correct URL/method/body), timeout wiring, error normalization (unknown/long/provider-looking strings fall back to generic).
- [ ] **Step 2: Run red.** `pnpm exec vitest run shell/src/lib/hermes-client.test.ts`
- [ ] **Step 3: Implement** the client with response interfaces matching the contract subset.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Stage & await go-ahead.**

---

## Task 3: Shell `HermesSettings.tsx` shared component

**Files:**
- Create: `shell/src/components/hermes/HermesSettings.tsx`
- Test: `tests/shell/hermes-settings.test.tsx`

**Interfaces:**
- Consumes: `hermes-client.ts` (Task 2).
- Produces: `<HermesSettings variant="section" | "overlay" />`. Tabs: **Overview** (status, current model/provider, offline empty-state), **Providers** (provider cards + write-only API-key entry → `setEnv`), **Models** (model list grouped by provider, select → `setModel`, redacted display), **Channels** (platform cards: enable/credentials → `updatePlatform`, test → `testPlatform`; Telegram QR onboarding flow). `variant` changes chrome/spacing only; all data logic shared. Mutations show generic errors on failure; never render raw provider/path strings.

- [ ] **Step 1: Tests first** (`tests/shell/hermes-settings.test.tsx`, mock `hermes-client`): tabs render; Overview offline/empty state when status `running:false`; Models list + select calls `setModel`; Providers API-key submit calls `setEnv` (write-only, redacted display); Channels list + enable + test call client; renders in both `section` and `overlay` variants.
- [ ] **Step 2: Run red.** `pnpm exec vitest run tests/shell/hermes-settings.test.tsx`
- [ ] **Step 3: Implement** the component, mirroring finna-cloud layout patterns with Matrix conventions (no `Set`/`Map` in state; `useMemo` for derived lists; reset `imgFailed` patterns N/A here). Obey shell gotchas.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: react-doctor** `npx react-doctor@latest shell` — resolve findings in changed files.
- [ ] **Step 6: Stage & await go-ahead.**

---

## Task 4: Wire into Settings + in-chat overlay; remove ChatApp stub

**Files:**
- Create: `shell/src/components/settings/sections/HermesSection.tsx` (thin wrapper rendering `<HermesSettings variant="section" />`)
- Modify: `shell/src/components/Settings.tsx` (add `{ id: "hermes", label: "Hermes", icon: ... }` to `sections`, import + render branch `activeSection === "hermes"`; do NOT add to `HIDDEN_SECTION_IDS`)
- Modify: chat surface (`shell/src/components/ChatApp.tsx`) — add a launcher control that opens `<HermesSettings variant="overlay" />` via shared dialog/`ShellNotificationStack` conventions + `SHELL_Z_INDEX`; **remove** `HermesSetupPanel` + `shell/src/lib/chat-app-hermes.ts` prompt-prefix + its localStorage key so the composer no longer rewrites prompts.
- Test: update/extend any ChatApp test that referenced the stub; add a Settings render test that "hermes" section is visible.

- [ ] **Step 1: Tests** — Settings shows the Hermes section (not hidden); ChatApp no longer imports the stub; overlay launcher opens HermesSettings.
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** wiring + stub removal.
- [ ] **Step 4: Run green** + `npx react-doctor@latest shell`.
- [ ] **Step 5: Production shell build** (changes shell): `bun run build:shell:production`.
- [ ] **Step 6: Stage & await go-ahead.**

---

## Task 5: VPS dashboard service (distro)

**Files:**
- Create: `distro/customer-vps/host-bin/matrix-hermes-dashboard`
- Create: `distro/customer-vps/systemd/matrix-hermes-dashboard.service`
- Modify: `distro/customer-vps/cloud-init.yaml` (register unit, add to enable list, `systemctl start --no-block` after the oneshot installer)
- Modify: `scripts/build-host-bundle.sh` (stage + `chmod 0755` the wrapper)
- Test: extend `tests/**/customer-vps-host-bundle.test.ts` (wrapper staged + executable, unit present/enabled)

- [ ] **Step 1: Wrapper** — source `matrix-owner-env`, resolve `$MATRIX_RUNTIME_HOME/.local/bin/hermes` + `HERMES_HOME`, `exec hermes dashboard --host 127.0.0.1 --port 9119`. Guard with `declare -F`/existence checks; degrade gracefully if hermes missing.
- [ ] **Step 2: systemd unit** — `Restart=on-failure`, `User=matrix`, `EnvironmentFile=/opt/matrix/env/host.env`, `After=matrix-hermes.service network-online.target`, `Wants=network-online.target`, `ConditionPathExists=` the wrapper/binary.
- [ ] **Step 3: cloud-init + build-host-bundle** wiring.
- [ ] **Step 4: Test** — extend host-bundle test; run it.
- [ ] **Step 5: Stage & await go-ahead.**

> Deploy note (CLAUDE.md): this is a customer-VPS shell+gateway+distro change → **host-bundle rebuild + publish**, refresh VPSes, `systemctl daemon-reload` + start `matrix-hermes-dashboard.service`, restart `matrix-gateway`/`matrix-shell`. Not a pre-VPS/platform-shell change. Surface this to the maintainer at the end; do not deploy from here.

---

## Task 6: Final verification

- [ ] All new tests green: `pnpm exec vitest run tests/gateway/hermes-proxy.test.ts shell/src/lib/hermes-client.test.ts tests/shell/hermes-settings.test.tsx`
- [ ] `bun run typecheck` clean.
- [ ] `bun run check:patterns` clean for changed files.
- [ ] `npx react-doctor@latest shell` clean for changed `.tsx`.
- [ ] `bun run build:shell:production` succeeds.
- [ ] Dev render: `/?launch=...` Settings → Hermes shows the panel in offline/empty state (no live Hermes locally) without console errors; overlay opens from chat.
- [ ] Summarize deploy steps (Task 5 note) for the maintainer.

## Self-Review
- Spec coverage: layers 1–3 (Tasks 5/1/2-4), security (Global Constraints + Task 1 tests), retire stub (Task 4), tests (each task), `/api/status` correction noted. Covered.
- Out of scope held: chat routing (061), OAuth provider login, secret reveal, aux model slots.
