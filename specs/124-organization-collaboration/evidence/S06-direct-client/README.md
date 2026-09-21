# S06 evidence: "Shared with me" with metadata-only discovery (T030–T034)

**PR:** #1806 `feat(collaboration): add the shared direct client and metadata-only discovery`.
**Date:** 2026-09-21. **Commit captured:** `ab3f577f5` (branch `124/s06`).
**What changed for users:** platform discovery (`GET /api/collaboration/inbox|shared`) now returns
metadata only. The shared direct client (`packages/ui/src/collaboration/direct-api.ts`) hydrates each
item from its home and, when the home cannot be reached or refuses the caller, marks the item instead
of dropping it. `ChatCollaboration.tsx` renders three new cards on the **Shared with me** page:

| Card | Trigger | Copy |
| --- | --- | --- |
| Organization-pending | platform item `status: "organization_pending"` (organization-wide share the member has not opened yet); no hydration | **Shared with your organization** · "Shared {kind} · opens when you join" · **Open** |
| Offline | hydration fails with `host_offline` (platform ticket route answers 404/503) or `unavailable` (network failure); client sets `home: "offline"` | **Shared {kind}** / **Invitation** · "The owner's computer is offline. Try again later." |
| Access unavailable | hydration fails with any other typed error (`denied` from 401/403, `not_found`, `upgrade_required`, …); client sets `home: "denied"` | **Shared {kind}** / **Invitation** · "Access is no longer available." |

The platform never sets the `home` marker itself (no `home:` in `packages/platform/src/collaboration/routes.ts`);
it is a client-side outcome of the direct client's ticket exchange, which is why the captures mock the
ticket route rather than the discovery payload to produce the offline and access-unavailable cards.

## How the screenshots were produced

### Web Canvas, Web Desktop, Web Mobile

- Shell dev server from this branch in the documented bypass configuration
  (`E2E_TEST_BYPASS=1 NEXT_PUBLIC_E2E_TEST_BYPASS=1`, `next dev --webpack` on `127.0.0.1:3006`,
  `GATEWAY_URL` pointed at an unused port). No gateway or platform process ran.
- Playwright (headless Chromium, 1440×900 for Web Desktop/Web Canvas, 390×844 for Web Mobile) mocked every
  gateway and platform call the shell makes (settings, identity, apps, bootstrap, chats, terminal
  workspaces, `/api/system/info` with `capabilities.collaboration=true` and a machine id) plus the
  collaboration API:
  - `GET /api/collaboration/inbox` → `{ items: [] }`;
  - `GET /api/collaboration/shared` → the scenario's metadata-only items (no `resource`), exactly the
    shape `CollaborationDiscoveryItemSchema` accepts after #1806;
  - `POST /api/collaboration/connections` (ticket issuance, the first call the direct client makes for
    any item without `resource`) → `503` for the offline scopes and `403` for the denied scope. The
    client therefore never reached a home; `direct-client.ts` mapped the statuses to `host_offline` and
    `denied`, and `direct-api.ts` marked the items `home: "offline"` / `home: "denied"`.
- Route: `/shared`, which `ShellHome` turns into the launched `__chat__` window with the
  `{ kind: "home" }` collaboration view. Web Canvas was selected by pre-setting the persisted
  `matrix-os-desktop-mode` store to `canvas`; Web Mobile is the same route at a phone viewport (the
  `MobileShell` Chat surface).
- Four scenarios per surface: `org-pending` (two organization-pending items), `offline` (an accepted
  Chat and a pending invitation whose home is unreachable), `denied` (an accepted terminal whose home
  refuses the caller), and `all` (all five cards on one page).
- The **Offline** label in the Chat window header comes from the shell's main socket having no gateway
  to reach in this harness; it is the Chat connection indicator, unrelated to the cards. The Clerk
  keyless-mode "Configure your application" dev prompt and the Next.js dev overlay were hidden before
  capture; both are dev tooling, not shell UI.
- Script: `capture-web.mjs` in this directory.

### Electron Desktop

- Built the desktop app from this branch (`electron-vite build`, Electron 41, `NODE_OPTIONS=--max-old-space-size=4096`)
  and drove the built renderer under `desktop/out` with Playwright `_electron.launch` under Xvfb at
  1440×900 on Linux, reusing the desktop e2e harness (`tests/e2e/desktop/fixtures/canonical-input-electron.mjs`,
  the `stub-gateway.ts` fixture, a synthetic credential seeded through `safeStorage`).
- A small HTTP server in front of the stub gateway served `/api/system/info` with
  `capabilities.collaboration=true` and a machine id, and the same three collaboration routes as the
  web run (metadata-only `shared`, empty `inbox`, `connections` answering 503/403 by scope). Everything
  else was proxied unchanged to the stub gateway. The desktop renderer uses the same
  `createCollaborationDirectApi` with `clientOrigin` set to the platform origin.
- Navigation: double-click **Chat** in the launcher, click **Shared with me** in the Chat rail
  (`SharedWithMeRailRow`), which opens the `shared` tab (`DesktopChatCollaboration`) as its own
  "Shared with me" window.
- Script: `electron-capture.e2e.test.ts` in this directory (see "Reproduction" below).

## Files

| File | Surface | State | Shows |
| --- | --- | --- | --- |
| `web-desktop-org-pending.png` | Web Desktop | organization-pending | Chat window on **Shared with me** with two "Shared with your organization · opens when you join" cards (project, Chat) and their **Open** buttons |
| `web-desktop-offline.png` | Web Desktop | offline | "Shared Chat" and "Invitation" cards with "The owner's computer is offline. Try again later." and no action |
| `web-desktop-denied.png` | Web Desktop | access-unavailable | "Shared terminal" card with "Access is no longer available." and no action |
| `web-desktop-all.png` | Web Desktop | all three | All five cards on one page (organization-pending first, then offline, then access-unavailable) |
| `web-canvas-org-pending.png` | Web Canvas | organization-pending | Same page inside the Canvas window chrome (zoom toolbar, rail dock) |
| `web-canvas-offline.png` | Web Canvas | offline | Same offline cards on Web Canvas |
| `web-canvas-denied.png` | Web Canvas | access-unavailable | Same access-unavailable card on Web Canvas |
| `web-canvas-all.png` | Web Canvas | all three | All five cards on Web Canvas |
| `web-mobile-org-pending.png` | Web Mobile | organization-pending | Phone-width Chat surface with the two organization-pending cards; **Open** buttons wrap beside the copy |
| `web-mobile-offline.png` | Web Mobile | offline | Offline cards at phone width |
| `web-mobile-denied.png` | Web Mobile | access-unavailable | Access-unavailable card at phone width |
| `web-mobile-all.png` | Web Mobile | all three | All five cards at phone width, tab bar below |
| `electron-desktop-org-pending.png` | Electron Desktop | organization-pending | "Shared with me" window over the Chat window with the two organization-pending cards |
| `electron-desktop-offline.png` | Electron Desktop | offline | Offline cards on Electron Desktop |
| `electron-desktop-denied.png` | Electron Desktop | access-unavailable | Access-unavailable card on Electron Desktop |
| `electron-desktop-all.png` | Electron Desktop | all three | All five cards on Electron Desktop (last card partly below the window fold) |

## Findings

- **All four surfaces render the same cards from the same component.** Web Canvas, Web Desktop, Web
  Mobile and Electron Desktop all mount `ChatCollaboration` with a `CollaborationDirectApi`; the copy,
  card order and the absence of actions on offline/access-unavailable cards are identical. Only the
  window chrome differs (Electron opens **Shared with me** as its own window rather than inside the
  Chat window).
- **Offline and access-unavailable are client-side outcomes, not platform fields.** The direct client
  hydrates every item that arrives without `resource`; the marker is decided by the typed error of the
  ticket exchange. A network failure (`unavailable`) also renders as offline; `not_found`,
  `upgrade_required`, `invalid_request` and `invalid_response` all render as "Access is no longer
  available." (any code other than `host_offline`/`unavailable`), so an outdated client shows the
  access copy rather than an upgrade prompt on this page. Worth a follow-up if the product wants a
  distinct upgrade message here.
- **Organization-pending cards carry no owner or title.** The platform item is metadata only and the
  client does not hydrate `organization_pending` items, so the card shows only the kind
  ("Shared project", "Shared Chat"). Pressing **Open** routes to `/shared/project/<scopeId>` (web) or
  sets the project view (Electron); actually opening the share needs S12/S15 per the PR's deferred
  scope, so that path was not captured.
- **Web Mobile is reachable.** The PR body marks Web Mobile N/A, but the browser shell at phone width
  renders the same Chat surface and the same cards (captured above). Native Mobile remains the recorded
  V1 limitation.

## Not captured

- **Opening an organization-pending share** (the **Open** button): needs the S12 home activation route
  and S15 platform ticket admission; with mocks it would only reach the "Shared project unavailable"
  fallback, which is not the changed behavior.
- **A hydrated (healthy) card next to the marked cards**: requires a full ticket/signature/home-session
  exchange against a mocked home, out of scope for this PR's changed states.
- **Native Mobile:** recorded V1 limitation in `spec.md`.

## Reproduction

From a checkout of this branch with dependencies installed (`pnpm install`), the brand and
observability packages built (`pnpm --filter '@matrix-os/observability' --filter '@matrix-os/brand' build`),
and Playwright's Chromium available.

Web surfaces:

```bash
cd shell && E2E_TEST_BYPASS=1 NEXT_PUBLIC_E2E_TEST_BYPASS=1 GATEWAY_URL=http://127.0.0.1:59999 \
  pnpm exec next dev --webpack -H 127.0.0.1 -p 3006 &
cd .. && S06_BASE=http://127.0.0.1:3006 S06_OUT=/tmp/s06-web \
  node specs/124-organization-collaboration/evidence/S06-direct-client/capture-web.mjs
```

`S06_SURFACE=web-desktop|web-canvas|web-mobile` and `S06_SCENARIO=org-pending|offline|denied|all`
limit a run.

Electron Desktop (Xvfb on Linux; on a workstation with a display, drop the `xvfb-run` prefix):

```bash
NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter desktop build
cp specs/124-organization-collaboration/evidence/S06-direct-client/electron-capture.e2e.test.ts tests/e2e/desktop/
for s in org-pending offline denied all; do
  S06_SCENARIO=$s S06_SHOT_OUT=/tmp/s06-electron xvfb-run --auto-servernum \
    --server-args="-screen 0 1440x900x24" pnpm exec vitest run --config vitest.e2e.config.ts \
    tests/e2e/desktop/electron-capture.e2e.test.ts
done
rm tests/e2e/desktop/electron-capture.e2e.test.ts
```
