# Expo loading, caching and native feel

Every generated app must deliver its primary flow in Web Mobile and actual Native Mobile. Native Mobile runs the Matrix Expo shell and an app WebView; it does not convert every Vite app into a separate React Native application. Design for touch and the authenticated installed host, not just a resized desktop browser. Use the Matrix development client or release build; Expo Go is not a supported Matrix runtime. See [Expo's development-build guidance](https://docs.expo.dev/develop/development-builds/introduction/).

## Current loading contract

Checked source: apps/mobile/lib/queries/use-computer-apps.ts, requests/apps.ts, requests/query-keys.ts, query-client.ts and components/AppRuntimeFrame.tsx. Verify the installed release because host behavior can change.

The shell resolves the active owner computer, lists apps with owner/computer query keys, and obtains a fresh app session through POST /api/apps/<slug>/session-token. It loads the returned launch URL in AppRuntimeFrame's react-native-webview. The frame has loading/error presentation, shared cookies, navigation gestures and inline media. Its external navigation handler keeps the runtime origin inside the frame and opens permitted external links separately.

The app catalog uses the existing query cache (default staleTime 30 seconds, gcTime 5 minutes, catalog polling 10 seconds). App-session queries instead use gcTime: 0, retry: false and refetchOnMount: "always". This is deliberate: a reusable app listing is different from an expiring launch credential. Do not persist or reuse a launch token/URL as a shortcut to a faster reopen.

The checked AppRuntimeFrame does not expose a complete MatrixOS database/integration bridge by itself. DOM storage enabled is not proof of an authenticated bridge or permission to store records locally. Verify host injection, typed transport, owner scope and persistence on the actual installed build. If any part is missing, repair the host dependency or record the exact developer check pending while completing independent app work. Do not claim an untested native data flow works.

## Three distinct caches

1. **Versioned app assets.** Prefer small local hashed JS/CSS and sized compressed imagery, lazy loading secondary routes and heavy maps/charts. Cache only immutable versioned assets through the supported host/HTTP policy. HTML/manifests must revalidate so an old document cannot load removed chunks. Check response headers and platform behavior; do not claim a cache policy exists merely because Vite hashes filenames. Do not add a root service worker in a sandboxed iframe or assume WebView caching authenticates future requests.
2. **Owner-scoped read results.** Use bounded in-memory query caching within the existing authenticated app/host layer when appropriate. Key by owner + computer/runtime + app + query/filter + schema version, excluding credentials and launch URLs. Choose freshness by task; refresh after a confirmed mutation, bridge change event, reconnect and foreground return. Preserve stable visible data while refreshing, with a last-updated indicator when useful. Abort or discard old-owner responses; clear on sign-out, owner/computer switch, app uninstall, permission change and schema incompatibility. Default app records remain in Postgres. Durable private offline caches require an approved encrypted host storage contract with clearing/eviction; do not create JSON, SQLite or localStorage persistence as a workaround.
3. **Navigation and view state.** Keep active tab, list scroll, selected record and current draft through supported in-session navigation. For bounded host view retention, scope to owner/computer/app/version, use LRU/TTL, stop hidden polling and dispose subscriptions. A retained WebView is not a background worker. Process termination is a cold start; only promise recovered drafts if the documented authenticated persistence actually restores them.

This is a builder policy, not a claim that a new persistent offline cache, app-session prefetch API or retained-view host manager has shipped. Improve available app assets/state first; host caching changes need their own implementation and tests. Never cache a successful write result before acknowledgement, replay a write automatically without an idempotency contract, or show a stale balance as current. With lost connectivity, preserve the draft, explain the pending/error state and retry deliberately. Offline support must be explicitly implemented and verified before being advertised.

## Make loading feel native

Keep chrome stable while loading; use a content-shaped skeleton or compact loading state, then retain the existing content during a refresh. Prevent repeated full-screen spinners, layout jumps and duplicate app/host navigation. Give taps immediate feedback and run only the needed critical-path data request. Scope hover to fine-pointer devices, keep touch targets at least 44×44px, and avoid delayed click feedback.

Use the documented host insets with dynamic viewport sizing, readable input text, appropriate keyboards and visible save/error controls above the keyboard. Verify Back, swipe navigation, nested scroll, pull-to-refresh, rotation and external links; avoid a refresh gesture swallowing a map pan or board drag. A gesture needs an accessible button/menu equivalent. Honor reduced motion and supported text scaling. For a timer, derive remaining time from a confirmed start/end timestamp rather than trusting a background JavaScript interval.

For detailed platform-dependent WebView options use the [react-native-webview reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md). A cacheEnabled prop or ordinary browser cache does not establish cross-platform offline readiness, owner isolation or correct session handling. Do not alter Native Mobile's cookie or origin policy just to improve a performance number.

## Required evidence

On an authorized physical device or simulator with the actual Matrix Expo development client, and on Web Mobile:

- Record host/build version, device/OS, network conditions and actual usable app width.
- Time cold launch, warm reopen and return from background separately: tap → shell/app frame visible → usable primary content. Record observed values; do not invent universal performance guarantees.
- Perform a real owner-Postgres read/create/edit, wait for confirmation, close/reopen, and cross-read on another surface. Verify errors and retry retain the draft.
- Change a record on another surface and return; ensure the read cache invalidates/revalidates and the updated record appears without falsely reporting stale data as fresh.
- Test expired session, app update with old cached assets, reconnect, sign-out, owner/computer switch and late responses. Confirm no old-owner content flashes and no cached credential bypasses session renewal.
- Exercise keyboard, touch, Back, scroll restoration, rotation, accessibility, reduced motion and truthful offline/loading/error states.

Put pass/fail/pending, timing observations and evidence paths in BUILD-REPORT.md. A mocked bridge, desktop resize, cached screenshot or skill update is supplementary evidence. Native readiness requires the observed native primary flow and loading/cache behavior.
