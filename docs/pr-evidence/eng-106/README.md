# ENG-106 Electron Desktop Chat evidence

Captured on 2026-10-23 from the current PR's Electron main and preload bundles with the current Vite renderer source. The Electron E2E uses a synthetic owner Chat with 500 Run activities and a local stub gateway. No customer data or production staging runtime is shown.

| State | Screenshot |
| --- | --- |
| Expanded Run at activity 500 | [expanded-500.png](expanded-500.png) |
| Reader manually scrolled to the start | [manual-scroll.png](manual-scroll.png) |
| Run work collapsed, final answer visible | [collapsed.png](collapsed.png) |
| Chat reopened after Electron's Reload menu action | [reloaded.png](reloaded.png) |

The E2E asserts viewport geometry and that a fresh Chat detail request occurs after reload. The menu unit test checks that the Reload action is bound to `CmdOrCtrl+R`. Playwright's synthetic key press did not reach Electron's native `before-input-event` in this headless environment, so the E2E invokes the same menu action directly.
