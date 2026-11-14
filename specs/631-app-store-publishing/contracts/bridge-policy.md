# Contract: Bridge policy for store surfaces and community apps

`packages/contracts/src/app-store-bridge-policy.ts` holds the shared rules. Web (`shell/src/components/app-viewer-bridge-policy.ts`), Electron (`desktop/src/shared/native-app-gateway.ts`) and Native Mobile's separate installed-app broker (`apps/mobile/lib/app-capability-bridge.ts`) must enforce equivalent identity-bound rules.

## `app-gallery` identity

The existing gallery rules stay. The gallery identity may also call these exact patterns:

- `GET /api/app-store/status`
- `GET /api/app-store/publishable-apps`
- `GET|POST /api/app-store/drafts`
- `GET /api/app-store/drafts/<uuid>`
- `GET /api/app-store/drafts/<uuid>/diff?path=…`
- `POST /api/app-store/drafts/<uuid>/revise|submit|listing|delete`
- `GET /api/app-store/submissions`
- `POST /api/app-store/submissions/<uuid>/withdraw`
- `GET /api/app-store/listings[?…]`
- `GET /api/app-store/listings/<slug>`
- `GET /api/app-store/listings/<slug>/icon`
- `POST /api/app-store/listings/<slug>/install`
- `GET /api/app-store/installs/<uuid>`
- `POST /api/app-store/listings/<slug>/rating`

## Reviewer routes (Gallery Review tab)

The Gallery identity may also call the five `/api/app-store/review/...` routes in `gateway-api.md`, with exact methods. Gallery shows its **Review** tab only when `GET /api/app-store/status` returns `reviewer: true`. The platform's reviewer allowlist is the access check: every review route returns 403 for other users.

Why no separate app: every user's home receives every bundled app, so a separate Store Review app would appear in everyone's launcher, and hidden apps are not registered. A second privileged bridge identity would also add attack surface without adding any protection.

## Community apps

An app is community when its slug appears in the gateway's provenance file. The gateway's app listing exposes this as `distribution: "community"`.

| Bridge call | Community rule |
| --- | --- |
| `db.*` (`/api/bridge/query`) | Allowed. The host stamps `app` with the app's own slug, and the gateway refuses `listApps` and any `app` other than the caller. |
| `readData`/`writeData` (`/api/bridge/data`) | Allowed, stamped |
| `service`/`integrations` (`/api/bridge/capabilities`) | Allowed, limited to the owner grant written at install |
| `proxyFetch` (`/api/bridge/proxy`) | Denied |
| `gatewayFetch` (any other URL) | Denied |
| App AI | Unchanged: governed by the owner's existing `~/system/app-ai.json` policy. Installing never grants AI; the `ai` permission is shown so the owner knows the app can use it once enabled. |

`isCommunityBridgeRequestAllowed(url, method)` is the one predicate used by both hosts. The Web host's `isAllowedBridgeFetchUrl(appName, url, method, distribution?)` calls it whenever `distribution === "community"`. Store routes use only `GET` and `POST`.

The gateway must bind an untrusted request to a launch/session principal, not trust an arbitrary `app` string from source. Never place owner bearer tokens in a community frame. Native Mobile has a real installed-app runtime; add exact Gallery routes and provenance-based restrictions there rather than assuming Web's gatewayFetch host is reused. Verify cross-app and forged-identity denial end to end on each runtime.
