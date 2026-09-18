# Cross-Surface Evidence

| Artifact | Surface | Demonstrates |
| --- | --- | --- |
| `output/playwright/collaboration-ux/web-canvas-chat.png` | Web Canvas | Native Chat window composition |
| `output/playwright/collaboration-ux/web-desktop-chat.png` | Web Desktop | Native desktop-web Chat composition |
| `output/playwright/collaboration-ux/web-desktop-shared-with-me.png` | Web Desktop | First-class discovery row, pending badge/actions, accepted resource, and native open action |
| `output/playwright/collaboration-ux/responsive-chat.png` | Responsive web, 390×844 | Compact native session chrome |
| `output/playwright/collaboration-ux/responsive-discussion.png` | Responsive web, 390×844 | Full-height discussion treatment |
| `output/playwright/shared-chat/electron-desktop.png` | Electron, 1440×900 | Shared with me opens a canonical Chat tab with title and controls in the native top bar |
| `output/playwright/shared-chat/electron-discussion.png` | Electron, 1440×900 | Opaque discussion drawer overlays the canonical Chat without a standalone collaboration page |

Commands: `shell/e2e/shared-chat.spec.ts` through Playwright's dev-server configuration, and `tests/e2e/desktop/shared-chat.e2e.test.ts` through Xvfb/Vitest Electron configuration.

No physical Expo device is attached to this Linux runner. Mobile parity is covered by 45 Jest tests, but a materially distinct native-device capture remains required before the mobile layer can be marked review-ready.
