# Local synthetic preview — not live release qualification

The desktop (1360×960) and phone (390×844) captures run the changed connected starter under local Vite with synthetic work/personal account identities and an injected test bridge. They show an in-progress import and the subsequent result state. Both measured document widths match the viewport; no horizontal overflow was observed.

The recordings are desktop-local.webm and mobile-local.webm. These show synthetic completion and empty fixture records; they do not establish actual Gmail import, provider coverage, app save/reopen, or installed-host/client behavior.

Before review readiness, attach current-commit live screenshots and recordings separately for Web Canvas, Web Desktop, Electron Desktop and Web Mobile. Native Mobile remains an explicit bridge limitation requiring a reviewed disposition. See ../plan.md for the owner/account, data preservation and rollout checks.
