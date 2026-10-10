# Gallery launcher and shared workspace chrome

## Goal and approved design

Use one transparent artwork family across Web Canvas, Web Desktop, Electron Desktop and Web Mobile. Preserve owner-selected icons and saved app identities. Desktop and Canvas have distinct generated monitor and overlapping-window artwork in the forest-green, ivory and brass family.

Implement the approved Figma top bar: [workspace](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1483-1294) and [menus](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1484-1528). Organization selection is hidden as authorized. Inbox means app/task notifications, explicitly confirmed by Hamed.

## Surface behavior

| Surface | Chrome and artwork | Transport |
| --- | --- | --- |
| Web Canvas | Shared View, Search, Inbox, Help, Computer and Account; existing canvas tools remain | Authenticated selected-runtime HTTP |
| Web Desktop | 38-pixel tab bar and shared menus; transparent launcher/dock and Gallery control | Authenticated selected-runtime HTTP |
| Electron Desktop | Same shared actions, View/Help/Inbox structure and artwork; native traffic-light reserve and drag region | Existing authenticated IPC/runtime slots |
| Web Mobile | Current-computer Terminal/Files/Gallery artwork; support launcher above the bottom dock | Existing mobile runtime connection |
| Native Mobile | Separate qualification in ENG-157; no new pass claimed | Existing native implementation |

Presentation choices remain independently remembered for Web and Electron. Mode switching and Show desktop preserve existing windows. App images have no opaque tile frame; missing-image fallbacks retain readable identity. Owner-selected icons take priority over built-in artwork.

Search opens the command palette. Help includes the existing getting-started progress, Support chat and Discord. The compact account menu contains Settings, View plans and Log out, using existing account and sign-out flows. Computer selection uses actual validated inventory and installed runtime identity, rather than the stored primary account choice; unavailable computers cannot be selected. Web navigation deliberately reloads to discard previous-computer sockets/state.

Inbox shows bounded real attention tasks and recent runtime activity. Loading, retry, verified empty and truncated states are shared. It does not invent unread state or repurpose Shared with me. Electron can activate existing native task tabs. Web attention rows currently show task information only: coding-agent thread IDs are not canonical web Chat IDs and must not be routed as if they were. Adding the web task detail destination is a separate capability boundary; notifications themselves have equivalent information and refresh behavior.

## Existing authentication boundaries

No new endpoint, permission or persistent notification store is added.

| Existing read path | Authentication/source | Public? |
| --- | --- | --- |
| `/api/coding-agents/summary` | Selected owner runtime authentication; shared RuntimeSummarySchema | No |
| `/api/auth/computers` | Existing Clerk account session; MatrixComputerListSchema | No |
| `/api/system/info` | Selected runtime; validated runtimeSlot | No |
| Native runtime summary/computer IPC | Existing main-process authenticated runtime slot and auth generation | No |

HTTP requests have a ten-second deadline. Computer effects abort on disposal; runtime-keyed state discards late responses. Inbox refresh timers are cleaned on unmount, do not overlap requests, and refresh every thirty seconds only while open. Shared schemas cap inventory/activity. User-facing failures stay generic. No owner files are rewritten by icon display or menu reads.

## Verification and delivery

Tests first cover source-scoped icons, transparency/fallbacks, menu actions, runtime selection races, actual notification states, saved explicit identity hydration and native menu overlays. A browser geometry regression reproduces the closed support launcher's overlap and verifies clearance at narrow widths without starting a server. Root typecheck, pattern scan, production shell, portable starter and native builds must pass. React diagnostics are compared with existing baselines. These are local checks, not live qualification.

Publish through the existing native stack #2407, request Greptile once per changed head, and add readiness only at exact-head 5/5 with zero unresolved blockers. Required Linux CI and exact-head disposable-preview evidence remain merge gates. Preserve owner data, dirty source/main checkouts and historical app profiles. Never start local preview servers or promote a production channel for this work.

Public documentation is updated in [site PR #204](https://github.com/FinnaAI/matrix-os-site/pull/204). Live screenshots and short recordings must cover each required surface, exact installed artifact, new artwork/top-bar actions/narrow support placement and the Gallery launch journeys; link verified Slack #tech evidence in the PR. Keep [ENG-157](https://linear.app/matrix-os/issue/ENG-157/ship-and-qualify-the-production-app-gallery-launch-journey) open while Native Mobile remains unfinished.
