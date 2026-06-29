# Spec 101 — Hermes Settings Panel

**Status:** Draft (awaiting review)
**Author:** (pairing session)
**Related:** `specs/061-agent-integration/SPEC.md` (planned `/api/agent/v1/*` chat proxy — complementary), `specs/077-matrix-messaging-bridge` (matrix-os's *own* channels — distinct system, see §9)

## 1. Summary

Matrix OS installs the Nous **hermes-agent** on every customer VPS, but only its
CLI is wired up — its rich web dashboard API (config, AI providers, model
catalog, messaging channels) is never served, and the shell has no UI for it.
The shell's only "Hermes setup" today is a cosmetic localStorage stub in
`ChatApp.tsx` (fake model names, four prompt-prefix channel toggles) that
touches no backend.

This spec delivers a **real, Molty-style Hermes settings surface** (modeled on
`finna-cloud`'s models/channels dashboard) that lets the owner see Hermes
status, choose an AI provider (via API key), pick the model, and manage
messaging channels — all wired to the actual hermes dashboard API.

## 2. Goals / Non-Goals

### Goals (V1)
- Serve the hermes dashboard API on the VPS (loopback) as a managed service.
- A guarded gateway proxy exposing an **allowlist** of hermes endpoints.
- One shared shell component, mounted both as **Settings → Hermes** and as an
  **in-chat overlay**, with tabs: **Overview, Providers, Models, Channels**.
- Real wiring through hermes' **unprotected** endpoints only (no session-token
  plumbing): config read, model catalog/select, API-key write, channel
  list/update/test, Telegram QR onboarding.
- Retire the `ChatApp` stub setup panel; replace with a deep-link/launcher into
  the real surface.

### Non-Goals (deferred to later phases)
- OAuth provider login flows (`/api/providers/oauth/*` — require the session
  token). V1 uses API-key entry only.
- Secret **reveal** (`/api/env/reveal` — token-protected). V1 shows redacted
  values only; keys are write-only from the UI.
- Auxiliary/per-task model slots, full config-schema editor, streaming &
  session-reset advanced settings, per-platform display tiers.
- Changing how the shell **chat** reaches its agent. The chat still uses the
  matrix-os kernel; this spec is settings-only. (Routing chat through hermes is
  spec 061's concern.)

## 3. Architecture (3 layers)

### Layer 1 — VPS: serve the dashboard
`hermes dashboard --host 127.0.0.1 --port 9119` binds loopback and, per hermes,
**leaves the auth gate off on localhost** (login is only required on
`--host 0.0.0.0`). Add:

- `distro/customer-vps/host-bin/matrix-hermes-dashboard` — wrapper that sources
  `matrix-owner-env`, resolves the hermes binary (`$MATRIX_RUNTIME_HOME/.local/bin/hermes`)
  and `HERMES_HOME`, then `exec`s `hermes dashboard --host 127.0.0.1 --port 9119`.
  Guard with `declare -F`/existence checks so older bundles degrade gracefully.
- `distro/customer-vps/systemd/matrix-hermes-dashboard.service` — long-running
  (`Restart=on-failure`), `User=matrix`, `EnvironmentFile=/opt/matrix/env/host.env`,
  `After=matrix-hermes.service network-online.target`, `Wants=network-online.target`,
  `ConditionPathExists=` the hermes binary or wrapper.
- `cloud-init.yaml`: register the unit file, add to the `systemctl enable` list,
  and `systemctl start --no-block` it after the oneshot installer.
- `scripts/build-host-bundle.sh`: stage + `chmod 0755` the new host-bin wrapper.

If hermes is not yet installed (installer still running/failed), the service
stays down; the gateway reports Hermes "offline" and the UI shows a setup state.

### Layer 2 — Gateway proxy
New `packages/gateway/src/routes/hermes.ts`, mounted at `/api/hermes` in
`server.ts`. Upstream base URL from `HERMES_DASHBOARD_URL`
(default `http://127.0.0.1:9119`).

Endpoints (each maps to one upstream hermes path; **allowlist only** — no
arbitrary pass-through):

| matrix-os route | hermes upstream | notes |
|---|---|---|
| `GET /api/hermes/status` | `GET /health` (+ `GET /api/model/info`) | coarse `{ running, configured, model?, provider? }` |
| `GET /api/hermes/config` | `GET /api/config` | read |
| `GET /api/hermes/model/options` | `GET /api/model/options` | provider + model catalog |
| `GET /api/hermes/model/info` | `GET /api/model/info` | current model |
| `POST /api/hermes/model/set` | `POST /api/model/set` | `{scope:"main",provider,model}` |
| `GET /api/hermes/env` | `GET /api/env` | redacted only |
| `PUT /api/hermes/env` | `PUT /api/env` | set API key (write-only) |
| `GET /api/hermes/messaging/platforms` | `GET /api/messaging/platforms` | list + status |
| `PUT /api/hermes/messaging/platforms/:id` | `PUT /api/messaging/platforms/:id` | enable/creds |
| `POST /api/hermes/messaging/platforms/:id/test` | `POST …/{id}/test` | coarse result |
| `POST /api/hermes/messaging/telegram/onboarding` | `POST …/telegram/onboarding/start` | QR start |
| `GET /api/hermes/messaging/telegram/onboarding/:pairingId` | `GET …/{id}` | poll |
| `POST /api/hermes/messaging/telegram/onboarding/:pairingId/apply` | `POST …/{id}/apply` | apply |
| `DELETE /api/hermes/messaging/telegram/onboarding/:pairingId` | `DELETE …/{id}` | cancel |

### Layer 3 — Shell surface
- `shell/src/lib/hermes-client.ts` — typed fetch wrapper for `/api/hermes/*`
  (subset response types) with `AbortSignal.timeout`.
- `shell/src/components/hermes/HermesSettings.tsx` — the **one** shared
  component. Tabs: Overview / Providers / Models / Channels. Accepts a
  `variant: "section" | "overlay"` for chrome/spacing differences only; all
  data logic is shared.
- `HermesSection.tsx` (settings wrapper) — add a `"hermes"` section to the
  Settings nav (exposed, not in `HIDDEN_SECTION_IDS`).
- In-chat launcher: a control in the chat surface opens `HermesSettings` as an
  overlay (shared `ShellNotificationStack`/dialog conventions, `SHELL_Z_INDEX`).
- Remove the `ChatApp` stub (`HermesSetupPanel`, `chat-app-hermes.ts`
  prompt-prefix) and its localStorage key; the chat composer no longer rewrites
  prompts with fake model/channel preambles.

## 4. Security architecture (per CLAUDE.md / quality gates)

- **Auth (source of truth):** every `/api/hermes/*` route requires the
  matrix-os request principal (`requireRequestPrincipal`). The hermes upstream
  is loopback and ungated; matrix-os auth is the only gate. Browser never talks
  to 9119 directly.
- **Input validation:** validate `:id` against `SAFE_SLUG`; validate
  `:pairingId` shape; per-endpoint Zod body schemas (model set, env set,
  platform update). `bodyLimit` on every mutating route (incl. DELETE).
- **No SSRF surface:** upstream is a fixed loopback host from server env, never
  user-controlled. Use `redirect: "error"`. Reject if `HERMES_DASHBOARD_URL`
  resolves to anything other than loopback at startup.
- **Error policy:** never forward raw upstream/provider error bodies. Log the
  real error server-side; return generic messages. Hermes unreachable →
  `503 { error: "hermes_unavailable" }`. Health/test endpoints return coarse
  booleans only (no upstream status codes/provider detail).
- **Timeouts:** `AbortSignal.timeout(10_000)` on every proxied fetch.
- **Secrets:** API keys are write-only through the UI; `GET /api/hermes/env`
  returns redacted values; reveal is out of scope (token-protected upstream).

## 5. Integration wiring

- **Startup:** gateway mounts `/api/hermes` unconditionally; it does not require
  hermes to be up at boot (status probe handles liveness per-request).
- **Cross-package:** shell → matrix gateway `/api/hermes/*` → hermes
  `127.0.0.1:9119`. No `globalThis`, no direct file access to `~/.hermes`.
- **Config source of truth:** `~/.hermes/config.yaml` + `~/.hermes/.env`, owned
  by hermes. matrix-os **never** writes those files directly — only via the
  hermes API. No new matrix-os persistence is introduced (stateless proxy).
- **Deployment:** customer-VPS shell + gateway + distro change → **host-bundle
  rebuild + publish**, then refresh existing VPSes and `systemctl daemon-reload`
  + start `matrix-hermes-dashboard.service` and restart `matrix-gateway`/
  `matrix-shell`. Not a pre-VPS/platform-shell change.

## 6. Failure modes

- **Hermes not installed / installer running:** dashboard service down → status
  `running:false` → UI shows "Hermes is setting up / not available" empty state;
  mutations return 503.
- **Dashboard crash:** `Restart=on-failure` recovers; status probe reflects
  transient downtime.
- **Upstream timeout / 5xx:** mapped to generic 502/503; UI shows retry.
- **Telegram pairing expiry:** poll returns expired → UI prompts restart.
- **Concurrent edits:** hermes owns its config; last-write-wins at the hermes
  layer (matrix-os adds no locking). Documented, acceptable for owner-only use.

## 7. Resource management

- Proxy holds no in-memory registries (stateless). No unbounded maps.
- Each request opens one upstream fetch with a hard timeout; no streaming
  buffers retained. (Telegram QR payload is small JSON.)
- No temp files.

## 8. Testing (TDD)

- **Gateway** (`tests/gateway/hermes-proxy.test.ts`): allowlist enforcement
  (unknown path 404), principal auth required, `:id` validation, body-limit,
  timeout → 503, generic error mapping (upstream 500 body not leaked), status
  up vs down (mock upstream fetch).
- **Shell**:
  - `hermes-client.test.ts` — request shaping, timeout, error normalization.
  - `hermes-settings.test.tsx` — tab rendering; Overview offline/empty state;
    Models list + select calls client; Providers API-key submit (write-only,
    redacted display); Channels list/enable/test; shared component renders in
    both `section` and `overlay` variants.
- **Distro:** extend the host-bundle test to assert the new wrapper is staged +
  executable and the systemd unit is present/enabled (mirror existing
  `customer-vps-host-bundle.test.ts`).

## 9. Notes / clarifications

- **Hermes channels ≠ matrix-os channels.** matrix-os has its own messaging
  system (spec 077 / hidden `ChannelsSection`, gateway adapters). This panel
  surfaces **hermes-agent's** platforms via the hermes API; the two are distinct
  and are not merged here. The UI labels this surface "Hermes" to avoid
  conflation.
- **Residual risk:** the dashboard is loopback + gate-off, so any local process
  on the VPS could reach 9119. Acceptable for V1 (single-tenant owner VPS);
  future hardening: bind to a unix socket or require a static token. Tracked as
  a follow-up, not V1 scope.

## 10. Deferred follow-ups
- OAuth provider login (session-token path).
- Secret reveal.
- Auxiliary model slots, config-schema editor, streaming/session-reset settings.
- Dashboard auth hardening (socket/token).
