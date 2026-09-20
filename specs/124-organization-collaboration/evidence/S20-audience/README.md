# S20 layer 3 evidence: organization-scoped share dialogs (T101)

**PR:** #1791 `feat(collaboration): scope every audience to the organization`. **Date:** 2026-09-20.
**What changed for users:** `ProjectSharingDialog`, `ChatCollaboratorsDialog`, `ShareChoiceDialog` and
`TerminalSharingButton` speak of organization members, and the project/terminal/Chat share buttons stay
disabled or refuse to start without an active Clerk organization (`CollaborationOrganization` gate).

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

## Not captured

- **Electron Desktop:** no Electron build was run in this harness.
- **`ShareChoiceDialog` ("Give members of your organization access…")** requires an open Chat with a
  session id; the Chat surface was not mocked in this pass.
- **Native Mobile:** recorded V1 limitation in `spec.md`.
