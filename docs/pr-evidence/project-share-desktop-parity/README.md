# Project Share parity evidence

These captures use synthetic data only and show no user, organization or project data.

| File | Surface | What it shows |
| --- | --- | --- |
| `web-desktop-project-share.png` | Web Desktop | The terminal sidebar groups sessions into Main and `launch-site`. The project heading carries the project Share control. |
| `electron-desktop-work-rail-project-share.png` | Electron Desktop | The Work rail project actions list the project Share entry between Show in Files and Delete project. |

In both captures no organization is active, so each control shows the existing organization-required state. On Web, the bypassed shell has no Clerk session. On `main`, Electron does not resolve an organization yet; PR #1957 adds that. Unit tests cover the organization-present path on both surfaces.

## How they were captured

- **Web Desktop:** run `E2E_TEST_BYPASS=1 NEXT_PUBLIC_E2E_TEST_BYPASS=1 next dev` from `shell/`. Open `?launch=__terminal__` in Chromium headless shell at 1440x900. The terminal workspace and system-info routes are mocked with one Main session and one `launch-site` project session, and the system info advertises collaboration.
  - Measured project Share: x 217, y 297, 217 x 38.
  - Measured project group: x 201, y 265, 279 x 128.
- **Electron Desktop:** native Electron under Xvfb after `bun run build:desktop`, against the repository stub platform.
  - The stub advertises collaboration.
  - A local proxy adds the canonical project id that real gateways return; the shared stub predates it.
  - Measured menu entry: x 198, y 494.4, 203.8 x 33.1, `aria-disabled="true"`.
