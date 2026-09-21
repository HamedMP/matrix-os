# S20 audience evidence: organization-scoped share dialogs (T101)

**PR:** #1795 (originally #1791) `feat(collaboration): share with organization members on every OS view`. **Date:** 2026-09-20 (web), 2026-09-21 (Electron Desktop).
**What changed for users:** `ProjectSharingDialog`, `ChatCollaboratorsDialog`, `ShareChoiceDialog` and
`TerminalSharingButton` speak of organization members, and the project/terminal/Chat share buttons stay
disabled or refuse to start without an active Clerk organization (`CollaborationOrganization` gate).

This UI PR includes the Electron Desktop captures, the tested capture/restoration helper, and
representative Web Canvas, Web Desktop, and Web Mobile frames. The remaining web frames and
the aggregate receipt are in evidence child PR #1817. The screenshots were produced from the
original combined UI tree, whose product UI diff is byte-identical to this restacked UI layer;
no fresh interactive capture was run after the helper-only correction.

## How the screenshots were produced

- Shell dev server from this branch in the documented bypass configuration
  (`E2E_TEST_BYPASS=1 NEXT_PUBLIC_E2E_TEST_BYPASS=1`, `next dev --webpack` on `127.0.0.1:3000`,
  `GATEWAY_URL` pointed at an unused port). No gateway or platform process ran.
- Playwright (headless Chromium, 1440×900 for Web Desktop/Web Canvas, 390×844 for Web Mobile) mocked every
  gateway and platform call the shell makes: settings, identity, apps, bootstrap, terminal workspaces
  (`main` plus a `launch-site` project workspace), window layouts, `/api/system/info` with
  `capabilities.collaboration=true` and a machine id, and the collaboration API
  (`scopes/preflight`, `scopes`, `scopes/:id`, `scopes/:id/members`, `scopes/:id/project/inventory`).
  The terminal tab socket was replaced with an in-page stub that replays two lines of output.
- Route: `/?launch=__terminal__`. Web Canvas was selected by pre-setting the persisted
  `matrix-os-desktop-mode` store to `canvas`; Web Mobile is the same route at a phone viewport.
- **No-organization state** is the bypass build as shipped: the gate renders `children(null)`.
- **Organization state** cannot be produced by the bypass build (it renders without Clerk), so the test
  rewrote the served dev chunk that contains the gate, replacing `children(null)` with a fixed
  `org_…` id before the browser executed it. No source file was changed; the dialogs, buttons and copy
  are exactly what the branch ships.
- The "Checking connection" toast in some frames comes from the shell's main socket having no gateway
  to reach in this harness; it is unrelated to the change.

### Electron Desktop

- Built the desktop app from this branch (`pnpm --filter desktop build`: electron-vite production build,
  Electron 41.7.1) and drove the built renderer under `desktop/out` with Playwright `_electron.launch`
  under Xvfb at 1440×900 on Linux, reusing the desktop e2e harness: the
  `tests/e2e/desktop/fixtures/canonical-input-electron.mjs` launch wrapper, the `stub-gateway.ts`
  fixture, and a synthetic credential seeded through `safeStorage` (no browser sign-in).
- A small HTTP server in front of the stub gateway served `/api/system/info` with
  `capabilities.collaboration=true` and a machine id, two Chats (`Launch plan`, `Matrix plan`), terminal
  keyboard preferences, and the collaboration API (`scopes/preflight`, `scopes`, `scopes/:id`,
  `scopes/:id/members`, `scopes/:id/project/inventory`); everything else, including the terminal tab
  socket, was proxied unchanged to the stub gateway.
- **No-organization state** is the built app as shipped: the trusted-core `auth:status` contract is
  strict and carries no `organizationId`, so the connection state stays `null` and
  `DesktopCollaborationOrganization` renders `children(null)`.
- **Organization state**: the trusted core cannot emit an organization yet, so the capture patched the
  built renderer chunk (`desktop/out/renderer/assets/index-*.js`), replacing the single
  `Reflect.get(status, "organizationId")` read with a fixed `org_…` id before launch and restoring the
  file afterwards. No source file was changed; the buttons, dialogs and copy are exactly what the branch
  builds.
- Script: `electron-capture.e2e.test.ts` in this directory (see "Reproduction" below).

## Files

| File | Surface | State | Shows |
| --- | --- | --- | --- |
| `web-canvas-no-org-project-share-disabled.png` | Web Canvas | no organization | Terminal window, sessions sidebar, `launch-site` project row with the disabled **Join an organization to share** button |
| `web-canvas-org-project-share-button.png` | Web Canvas | organization | Same row with the enabled **Share** button |
| `web-canvas-org-project-share-dialog.png` | Web Canvas | organization | `ProjectSharingDialog`: "…with members of your organization only", inventory, external references, membership changes |
| `web-canvas-org-project-collaborators-dialog.png` | Web Canvas | organization | `ChatCollaboratorsDialog` (project): "Sharing is limited to current members of your organization…", **Invite an organization member**, **Member email or username**, member list |
| `web-desktop-no-org-terminal-window.png` | Web Desktop | no organization | Terminal window in the desktop-parity layout: neither the project share button nor the terminal share button is rendered (see finding below) |
| `web-desktop-org-terminal-window.png` | Web Desktop | organization | Same window with an organization injected: still no share control |
| `web-mobile-no-org-terminal-share-button.png` | Web Mobile | no organization | Terminal chrome with the **Share** button |
| `web-mobile-no-org-terminal-share-unavailable.png` | Web Mobile | no organization | After pressing Share without an organization: "Terminal sharing is unavailable. Try again later." |
| `web-mobile-no-org-project-share-disabled.png` | Web Mobile | no organization | Sessions list with the disabled **Join an organization to share** button |
| `web-mobile-org-terminal-confirm-dialog.png` | Web Mobile | organization | "Share this whole terminal?" with "Members of your organization you invite…" and **Confirm and invite members** |
| `web-mobile-org-terminal-collaborators-dialog.png` | Web Mobile | organization | `ChatCollaboratorsDialog` (terminal) with the organization copy |
| `web-mobile-org-project-share-button.png` | Web Mobile | organization | Sessions list with the enabled **Share** button on the project row |
| `web-mobile-org-project-share-dialog.png` | Web Mobile | organization | `ProjectSharingDialog` at phone width |
| `web-mobile-org-project-collaborators-dialog.png` | Web Mobile | organization | `ChatCollaboratorsDialog` (project) at phone width |
| `electron-desktop-no-org-terminal-share-button.png` | Electron Desktop | no organization | Terminal window (`TerminalsTab`) with the selected session and the **Share** terminal button |
| `electron-desktop-no-org-terminal-share-unavailable.png` | Electron Desktop | no organization | After pressing Share without an organization: "Terminal sharing is unavailable. Try again later." |
| `electron-desktop-no-org-chat-share-button.png` | Electron Desktop | no organization | Chat window with the open `Launch plan` Chat and the **Share** control in the header |
| `electron-desktop-no-org-chat-share-choice-dialog.png` | Electron Desktop | no organization | `ShareChoiceDialog` offering only **Share snapshot**: no **Invite collaborators** without an organization |
| `electron-desktop-org-terminal-share-button.png` | Electron Desktop | organization | Terminal window with the enabled **Share** terminal button |
| `electron-desktop-org-terminal-confirm-dialog.png` | Electron Desktop | organization | "Share this whole terminal?" with "Members of your organization you invite…" and **Confirm and invite members** |
| `electron-desktop-org-terminal-collaborators-dialog.png` | Electron Desktop | organization | `ChatCollaboratorsDialog` (terminal): "Sharing is limited to current members of your organization…", **Invite an organization member**, **Member email or username**, member list |
| `electron-desktop-org-chat-share-button.png` | Electron Desktop | organization | Chat window with the **Share** control |
| `electron-desktop-org-chat-share-choice-dialog.png` | Electron Desktop | organization | `ShareChoiceDialog` with **Invite collaborators**: "Give members of your organization access to this ongoing Chat and its discussion." |
| `electron-desktop-org-chat-collaborators-dialog.png` | Electron Desktop | organization | `ChatCollaboratorsDialog` (Chat) with the organization copy and member list |

## Findings

- **Web Desktop does not expose either share control on this branch.** `DesktopWindow` passes
  `desktopParity` to the Terminal app, which renders `DesktopTerminalSidebar` (no project groups, so no
  `ProjectSharing`) and `DesktopTerminalSessionHeader` (no `TerminalSharingSlot`). The chrome that hosts
  the terminal share button renders only when the Terminal app is mounted with `mobile`. This is
  pre-existing layout code that #1791 does not touch; the PR only changes the shared components' props
  and copy. It needs a follow-up before Web Desktop can claim the parity the surface matrix requires.
- **Web Canvas** renders the full sessions sidebar, so the project share button and both project dialogs
  are reachable there; the terminal share button is not (same `mobile`-only chrome).
- **Web Mobile** (browser shell at phone width) renders the terminal chrome with the share button and the
  sessions list with the project share button, so every changed dialog is reachable there.

- **Electron Desktop does not expose the project share control on this branch.** The project tab
  (`WorkTab` route `project`) renders `ProjectChatsView` with `allowLegacyFallback={false}`, which mounts
  the canonical Chat route; `DesktopProjectSharing` is the `headerAction` of `ProjectThreadList`, which
  only the legacy `LegacyProjectChatsView` renders. The command palette, the Chat rail's project group
  and the project's Chats all land in the canonical workspace, so the **Share project** button is
  unreachable on Electron Desktop. Pre-existing layout code that #1795 does not touch; same class of
  gap as the Web Desktop finding above (tracked with #1798 / S15 T078). The terminal share button
  (`TerminalsTab` header) and the Chat share control (`WorkTab` chrome) are reachable, so every changed
  dialog except `ProjectSharingDialog` was captured on Electron Desktop.

## Not captured

- **Electron Desktop `ProjectSharingDialog` / project collaborators dialog:** the project share button is
  unreachable there (see Findings); the project dialogs are covered by the Web Canvas and Web Mobile
  captures, which render the same `@matrix-os/ui` components.
- **`ShareChoiceDialog` on the web surfaces:** requires an open Chat with a session id, which the web
  harness did not mock; it is captured on Electron Desktop in both states instead.
- **Native Mobile:** recorded V1 limitation in `spec.md`.

## Reproduction (Electron Desktop)

From a checkout of this branch with dependencies installed and Xvfb available (`xvfb-run`; on a
workstation with a display, drop the `xvfb-run` prefix):

```bash
NODE_OPTIONS=--max-old-space-size=4096 bun run build:desktop
cp specs/124-organization-collaboration/evidence/S20-audience/{electron-capture.e2e.test.ts,renderer-asset.ts,capture-safety.ts} tests/e2e/desktop/
S20_SHOT_MODE=no-org S20_SHOT_OUT=/tmp/s20-electron xvfb-run --auto-servernum \
  --server-args="-screen 0 1440x900x24" pnpm exec vitest run --config vitest.e2e.config.ts \
  tests/e2e/desktop/electron-capture.e2e.test.ts
S20_SHOT_MODE=org S20_SHOT_OUT=/tmp/s20-electron xvfb-run --auto-servernum \
  --server-args="-screen 0 1440x900x24" pnpm exec vitest run --config vitest.e2e.config.ts \
  tests/e2e/desktop/electron-capture.e2e.test.ts
rm tests/e2e/desktop/electron-capture.e2e.test.ts tests/e2e/desktop/renderer-asset.ts tests/e2e/desktop/capture-safety.ts
```

The `org` run patches the built renderer chunk for the duration of the run and restores it in
`afterAll`. `S20_ONLY=terminal|project|chat` limits a run to one flow; the `project` flow documents the
unreachable control and writes `failure-<mode>-project.png` plus a DOM summary to the log.
