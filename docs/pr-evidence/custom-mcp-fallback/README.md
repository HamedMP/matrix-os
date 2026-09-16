# Custom MCP unavailable fallback

Validation for PR #1691, captured on 2026-09-16.

## Scope

The captures use this PR's application source. The isolated validation runtimes
use fixture users and controlled API responses; no production account, feature
flag, service, or user data is changed.

The browser sequence opens Settings, receives HTTP 503 with
`{"error":"custom_mcp_unavailable"}`, verifies the unavailable alert and disabled
management fields, clicks Retry, holds the response to inspect loading, then
returns HTTP 200 with an empty server list. The recovered view must show the
empty state and enabled management fields.

## Electron Desktop

Actual Electron 41.7.1 under Xvfb, with this PR's main/preload build and renderer
served by Vite. A temporary profile completes the existing stub gateway's device
sign-in flow. MCP responses come from a temporary extension of that HTTP stub,
so the normal Electron credential injection, CORS handling, API client, and
Settings component remain active. The three-state assertion passed.

- [Unavailable, with Retry and disabled management](electron-desktop-unavailable.png)
- [Retry in progress](electron-desktop-loading.png)
- [Recovered empty state](electron-desktop-recovered.png)

The fixture's Getting started popover remains visible; it is unrelated to MCP
availability. No production credentials or private customer information appear.

## Web Desktop and Web Canvas

Actual Next.js application in Chromium, at 1440 by 1000 pixels. The local preview
uses the repository's E2E auth bypass, a test publishable key, and fixture API
responses. Web Desktop opens Settings from its desktop icon. Web Canvas first
switches through the command palette's `Mode: Canvas` action and opens Settings
from `dock-settings`. Both three-state assertions passed.

| Presentation | Unavailable | Loading | Recovered |
| --- | --- | --- | --- |
| Web Desktop | [Screenshot](web-desktop-unavailable.png) | [Screenshot](web-desktop-loading.png) | [Screenshot](web-desktop-recovered.png) |
| Web Canvas | [Screenshot](web-canvas-unavailable.png) | [Screenshot](web-canvas-loading.png) | [Screenshot](web-canvas-recovered.png) |

The connection notification reflects the fixture's absent live WebSocket backend;
it is independent of the successful MCP retry. The Add button remains disabled
in the recovered captures because the required name and URL are empty; assertions
verify that the form fields become enabled.

The Web captures used Turbopack after webpack development compilation exceeded
the practical local resource budget. Temporary dependency-root and source-import
aliases matched the normal webpack source resolution; these were removed after
capture. All application source and launch behavior remain unchanged.

## Build validation

`bun run build:shell:production` passed on `5768d4fa07e2267488cb730ce077b1eee7129aa4`
in [GitHub CI run 35089143962](https://github.com/HamedMP/matrix-os/actions/runs/35089143962).
Local production compilation was stopped after resource contention on the shared
VPS. The same canonical gate completed on the CI runner with frozen dependencies.

## Documentation preview

The companion documentation PR #110 was rendered from its Vercel preview.
The new copy is readable and the document has no horizontal overflow at each
checked width:

- [375 pixels](docs-375.png)
- [768 pixels](docs-768.png)
- [1440 pixels](docs-1440.png)

These documentation captures are separate from application runtime evidence.
