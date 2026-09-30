# Project Share parity evidence

These captures use synthetic data only and show no user, organization or project data.

| File | Surface | What it shows |
| --- | --- | --- |
| `web-desktop-project-share.png` | Web Desktop | The terminal sidebar groups sessions into Main and Launch Site. The project heading shows the project's name and carries the project Share control. |
| `web-canvas-project-share.png` | Web Canvas | The terminal drawer's project heading shows the same name and project Share control. |
| `web-mobile-project-share.png` | Web Mobile | The same drawer heading and project Share control in the mobile sessions list (390px touch viewport). |
| `electron-desktop-work-rail-project-share.png` | Electron Desktop | The Work rail project actions list the project Share entry between Show in Files and Delete project. |

In all captures no organization is active, so each control shows the existing organization-required state. On Web, the bypassed shell has no Clerk session. On `main`, Electron does not resolve an organization yet; PR #1957 adds that. Unit tests cover the organization-present path on every surface.

## How they were captured

- **Web:** run `E2E_TEST_BYPASS=1 NEXT_PUBLIC_E2E_TEST_BYPASS=1 next dev` from `shell/`. Open `?launch=__terminal__` in Chromium headless shell: Web Desktop and Web Canvas at 1440x900, Web Mobile at a 390x844 touch viewport with the sessions list opened. The mocked gateway has one Main session and one session in project `proj_launch`, the project list names it "Launch Site", and the system info advertises collaboration.
  - Web Desktop project Share: x 217, y 297, 217 x 38 (group x 201, y 265, 279 x 128).
  - Web Canvas project Share: x 334.2, y 421.5, 238.8 x 38 (group x 218, y 421.5, 355 x 98).
  - Web Mobile project Share: x 131.2, y 249.5, 238.8 x 38 (group x 20, y 249.5, 350 x 98).
- **Electron Desktop:** native Electron under Xvfb after `bun run build:desktop`, against the repository stub platform.
  - The stub advertises collaboration.
  - A local proxy adds the canonical project id that real gateways return; the shared stub predates it.
  - Measured menu entry: x 198, y 494.4, 203.8 x 33.1, `aria-disabled="true"`.
