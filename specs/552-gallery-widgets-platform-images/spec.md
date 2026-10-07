# Matrix App Gallery and desktop widgets

## Product decision

Use the user's October 7 visual references as direction, not as a product to copy. Matrix keeps its identity and owner-controlled data. The visual theme is a soft atmospheric desktop with expressive app artwork, a quiet floating navigation bar and large, useful previews. Each app gets a layout based on its subject: travel maps and itinerary, spending receipts and charts, readable meeting briefs, and project lanes. The common system provides navigation, focus, permissions and loading states; it does not make every app the same dashboard.

Names follow the [iOS naming and launch memo](https://linear.app/matrix-os/document/ios-app-review-research-naming-runtime-payments-and-october-launch-3bbbfc129ee8): **Apps** means installed applications, **Matrix App Gallery** is curated discovery, **Tools** connects integrations, and **Templates** are blueprints copied into an owner's app. Avoid App Store and the compound AppGallery in visible labels. October 15 starts with qualified free first-party apps. Ratings require actual installation and a server-backed submission; preview ratings are explicitly examples. Community executable publishing is outside this launch scope.

## Experience

1. Connect a tool, select the exact source accounts and label them Personal or Work. Keep these labels as owner-controlled metadata; an email domain can suggest a label but cannot silently choose a source or change permissions.
2. Recommend apps using supported actions and granted account scopes. Show what an app can do now and what another connection would enable. A failed catalog fetch must not turn into a false empty recommendation list.
3. Explore generous previews, useful categories and Personal/Business filters. App names and icons sit above each preview. Show real first-party app screens with fictional review data. Generated artwork is for icons and illustration, never presented as a screenshot.
4. Review connections, permissions and data scope; install through the normal catalog path. Confirm readiness from the actual runtime and open the installed copy. Preserve the owner's existing copy rather than overwriting it.
5. Preview phone, tablet and desktop layouts. Mobile previews must exercise actual app content at that width; scaling down a wide desktop screenshot is insufficient.
6. Add a qualified app widget to the desktop. The widget is a compact app view with one primary action. Open app, change size, move and remove are universal actions; subject-specific actions remain typed and permission checked.

## What desktop widgets require

Current source has shared OS-view contracts and durable revisioned state, Web Desktop and Electron Desktop presentation adapters, app data bridges, a cron service, Electron native notification infrastructure and a Native Mobile Expo push channel. It does **not** have an app-widget manifest/host or a universal app notification bridge.

Verified starting points:

- `packages/contracts/src/os-view.ts`: strict schemaVersion 1 documents for app state, desktop windows/icons and canvas windows/transform. Widgets cannot be silently added to the current schema.
- `packages/gateway/src/os-view-state/repository.ts`: owner Postgres state with revisions and idempotent mutation IDs. Use this authority for layout; do not introduce a second localStorage layout store.
- `shell/src/components/desktop/WebDesktopSurface.tsx` and `desktop/src/renderer/src/features/desktop-shell/NativeDesktopShell.tsx`: different presentation composition, shared domain state. Both need the same widget components and actions.
- `shell/src/components/AppViewer.tsx`: sandboxed app bridge injection and app-scoped data requests. Widget sessions need their own scoped bridge, never a global credential-bearing object.
- `packages/gateway/src/cron/service.ts` and `packages/kernel/src/ipc-server.ts` `manage_cron`: Matrix already schedules tasks. A browser timer is not the background scheduler.
- `apps/mobile/components/AppRuntimeFrame.tsx`: authenticated WebView navigation and loading states, but no MatrixOS data bridge injection/onMessage path. Responsive CSS alone does not qualify Native Mobile persistence.
- `apps/mobile/lib/push.ts`: Expo registration/tap routing currently resolves categories to the launcher; app-specific destination routing is additional work.
- `desktop/src/main/index.ts`: native notifications currently center on coding-agent events. Arbitrary apps do not automatically inherit this API.

### Shared widget contract (proposed, not shipped)

Extend the app manifest with reviewed widget definitions: stable ID, title, allowed sizes, renderer type, data source and declared permissions. Start with a **first-party typed renderer registry** rather than executing an arbitrary community iframe on the desktop. Built-app widget extensions come after session scoping and isolation qualification.

Each widget instance stores a UUID, owning app ID, definition ID, size, bounded layout coordinates, presentation order and validated app-specific settings. The source account selection is a reference to granted accounts; provider tokens never enter settings. Persist under a versioned OS-view schema migration that preserves every existing app/window/icon entry. A widget with a missing or uninstalled app remains a recoverable unavailable card with remove/open-gallery actions; it must not disappear or run stale code.

Use a focused shared WidgetHost/WidgetCard component in `packages/ui`, contracts in `packages/contracts`, gateway registry/data services and thin Web Desktop/Electron Desktop/Web Canvas adapters. Consume `@matrix-os/brand` and OS theme tokens for common surfaces. Widget artwork may have subject-specific color; it cannot change the owner's global theme.

### First five production candidates

| Widget | Primary value | Action | Data and fallback |
|---|---|---|---|
| Clock | Local time and selected cities | Open Clock | Local time; no network required |
| Notes | Selected note or quick capture | Open/edit note | Owner app record; preserve unsaved text on failure |
| Agenda | Next event and the day's timeline | Open selected event | Granted calendar accounts; explicit empty/error states |
| Spending | Settled amount and short period trend | Open Folio | Owner records; separate currencies, paid/refund status and scope |
| Weather | Current conditions with illustration | Open Weather | Validated location; stale timestamp and unavailable state |

Photos, reading/news, travel countdown and focus follow after qualification. Private photos never become gallery screenshots automatically. Sports imagery/scores in the user's references are art direction, not evidence of a connected sports feed.

### Layout and parity

Web Desktop and Electron Desktop support an edit mode: add, move, small/medium/large size, keyboard move, remove, undo after confirmed removal and accessible context menus. Drag handles are distinct from widget actions. Fit layout visually to viewport without rewriting the owner's canonical placement on every resize. A small screen stacks cards in a useful order rather than producing horizontal document overflow.

Web Canvas offers the same definitions, data and actions through its existing spatial presentation. Web Mobile and Native Mobile use a vertical compact board when the capability exists there; no desktop-style drag requirement. The same account filters, permissions, loading, stale, empty and error semantics apply everywhere. Native Mobile rollout waits for an authenticated app bridge and save/reopen tests in the Expo dev client.

### Data, refresh and caching

Render from a bounded cached snapshot, then revalidate. Cache keys include owner, machine/runtime, app version, widget ID and exact account/scope selection. Clear data on sign-out, runtime switch, permission revocation or app removal; never reuse another owner's decoded content. Cache is an optimization, not the owner database.

Suggested initial bounds: 32 instances per owner, 12 actively rendered widget sessions, 64 KiB per snapshot and a 4 MiB total in-memory LRU cache. Snapshot freshness is source-specific: clock uses a local visible timer, calendar/spending use app change events plus a bounded refresh, weather has a minimum five-minute fetch interval. Suspend offscreen/hidden rendering and cancel fetches on removal. No model or provider request is triggered by mounting or painting a card. AI-generated artwork is a deliberate action subject to its own allowance.

Background refresh uses Matrix's existing gateway scheduler, app permissions and configured integration scopes. Coalesce identical owner/source requests. Publish generic invalidation events after durable data changes. WebSocket subscribers require size caps, stale-connection eviction, isolated sends and shutdown cleanup.

For Native Mobile, start with versioned cached static app assets plus owner-scoped read snapshots after the bridge is qualified. Display the last confirmed data quickly, revalidate on foreground and expose stale/error state. Do not cache bearer headers, provider tokens or private responses in a public service-worker bucket. Offline reads and edits are distinct: queued edits need revision/conflict handling and must never be reported as a confirmed save before synchronization.

### App notifications

A future app notification API must be implemented as a gateway-owned permissioned service. Proposed shape: app ID, deduplication key, bounded title/body, severity and typed app-record destination. The gateway derives the owner and checks the manifest/grant, records the notification durably and delivers through existing shell/push channels. Apps never talk directly to Expo push or Electron main-process IPC.

Web Desktop/Web Canvas get a notification center and permission-gated browser notifications. Electron Desktop uses native notifications with a validated app destination. Native Mobile uses Expo push, owner-specific registration and authenticated app tap routing. Opt-in preferences, per-app throttles, quiet hours, privacy previews and delivery/read state are necessary. Reuse scheduler events for reminders; do not ask each app to run its own systemd daemon. Current coding-agent notification APIs are infrastructure references, not a universal app API to advertise today.

## Security and auth matrix

These widget routes are proposed until the host implementation lands. All mutable bodies have Hono bodyLimit and strict discriminated schemas.

| Boundary | Authentication/authorization | Public? | Bounds |
|---|---|---|---|
| Existing OS-view GET/PATCH | Gateway request principal; owner-derived row scope; PATCH revision and mutation ID | No | Existing 256 KiB body limit; widget schema enforces 32 instances |
| Proposed widget definitions GET | Authenticated owner, installed trusted catalog and permission projection | No | 128 definitions/page; no executable payload |
| Proposed widget snapshot GET | Authenticated owner plus app/widget session and granted source account | No | 64 KiB output; source-specific timeout; no arbitrary URL |
| Proposed widget action POST | Owner/session, manifest grant, typed action/record payload and revision | No | 32 KiB request; 10-second external API timeout; transaction for related writes |
| Proposed app notification POST | Owner/app session, notifications permission, bounded dedup key and typed destination | No | 8 KiB body; durable dedup and capped fanout |
| Funded image service | Runtime-bound domain credential plus active machine/owner and explicit platform allowance | No | See implementation's image domain contract; provider key stays platform-only |
| Public `/apps` and tool pages | No authentication; reviewed metadata/fictional assets only | Yes | No owner app records or private preview exports |

Validate route parameters, cursor, slug, dimensions and all settings at the boundary. No wildcard CORS, unvalidated server-side URLs, provider details in client errors or arbitrary native APIs. Resolve registry/service dependencies at registration time. Use Postgres transactions for state+outbox changes, enforce revision in UPDATE, and notify subscribers only after commit.

## Public catalog and future sharing

The landing page and public gallery use crawlable app pages with useful descriptions, required integrations, explicit qualification status and public-safe preview assets. Free tools remain genuinely usable without Matrix provisioning. Improve the existing whiteboard route with local drawing/export instead of adding a duplicate thin page. Other useful search-entry categories already in the tools catalog can be strengthened with real tasks rather than keyword-only pages; traffic estimates require Search Console or actual keyword research, not invented numbers.

Future community flow: creator opt-in, sanitized package/metadata, scoped permissions, review, signed immutable version, public listing and withdrawal. Public metadata showcases are separate from executable installation. Creator owns the app IP; each installer owns their instance data. No public owner mail/calendar/private images, fake creators, ratings or install counts. Native Mobile community execution remains subject to runtime/security and distribution-policy qualification.

## Qualification and rollout

The current deliverable is an interactive design preview, a widget implementation spec, public catalog/tool source and bounded funded-image source. Production widget hosting is a separate implementation phase. Do not relabel the preview as installed desktop widgets.

Sequence: shared contracts/data registry and migrations; first five widgets on Web Canvas, Web Desktop and Electron Desktop; permissions/notifications/scheduler; qualified mobile bridge/cache; community extensions. Each phase requires focused tests, end-to-end owner isolation and actual rendered evidence. Gallery browser inspection is currently denied by tool policy and must not be bypassed; source checks do not count as screenshots.

Public documentation is delivered in a separate private-site PR. Production activation of images requires configured platform funding, valid runtime credentials and a verified live image call. No merge, fleet rollout or provider-key change is part of design review.


## Large-file extraction plan

The existing IPC and platform/gateway composition files exceed the repository’s size guidance. Keep this release’s wiring minimal and carry out these scoped extractions before adding more image behavior: move the image tool definition/handler from `packages/kernel/src/ipc-server.ts` into a focused module with injected funded/BYOK dependencies; move image configuration/service/route/shutdown composition from `packages/platform/src/platform-startup.ts` into an image-runtime module; move client construction from the large gateway entrypoint into its feature initializer; move image activation assertions out of the large customer-VPS test file into a focused lifecycle suite. Preserve explicit funding selection, startup-time dependency resolution, generic errors, token rotation and existing full-chain tests. These are extraction steps, not permission to expand unrelated large files.
