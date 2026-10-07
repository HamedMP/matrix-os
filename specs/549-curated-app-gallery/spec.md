# Curated app gallery: product and platform contract

The owner installs a first-party starter from a reusable collection of 12 Personal and 12 Business apps. Each app is a portable Vite project with a separate owner Postgres schema. Personal/Business are discovery collections on the current computer; they do not create an organization or transfer ownership.

## Requirements

- R1: Show all 24 useful starters with search, categories, previews, and live connection readiness.
- R2: Install trusted local app source and built assets idempotently without overwriting existing apps or data.
- R3: Provide actual record editing, evidence, relevant views, and currency-safe financial summaries; start empty.
- R4: Require exact account selection and a bounded range for an explicit Matrix-assisted read-only import. Preserve source evidence and manual edits. Distinguish a request from completed processing.
- R5: Preserve a shared catalog/readiness source of truth and all bridge-enabled OS views.
- R6: Deliver tests, portable source, release packaging, screenshots, separate public documentation, and reviewed PRs.

## Surface matrix and explicit limitation

| Surface | Presentation and actions |
| --- | --- |
| Web Desktop | Discoverable app; shared injected app bridge; complete gallery, install/open, records and import request |
| Web Canvas | Same app and bridge; identical state/actions in spatial chrome |
| Electron Desktop | Same gallery/workspace UI and API; native preload adapts the shared capabilities, exact account inventory, app opening and kernel import dispatch |
| Web Mobile | Same bridge-enabled web app renderer with responsive layout |
| Native Mobile | Unavailable-state explanation directing to the three bridge-enabled desktop views; full gallery/workspace actions await a native app bridge |

Native Mobile currently uses `apps/mobile/components/AppRuntimeFrame.tsx` to open a session URL directly in a WebView. It does not inject `window.MatrixOS` or handle the parent app bridge. This is an explicit platform limitation: pretending that native installation, app database writes, or Matrix-assisted imports work would be false. This feature does not widen raw app-session permissions or duplicate a native bridge. Installed apps must explain the unavailable state when the bridge is absent. Building and validating that native bridge is a separate capability; no native completion is claimed here.

## Release and data invariants

The gateway reads the immutable bundled catalog/template rather than owner-modifiable definitions for installation. Catalog GET and install POST require the authenticated owner principal bound to the runtime home. Only the gallery receives exact method/path bridge allowances. Installed records stay in owner Postgres; examples and screenshots are illustrative and never seeded. Source integration execution remains kernel-mediated and its production app bridge guard remains intact. Existing custom Folio and Atlas are returned as installed without overwriting them.

The production host bundle builds the gallery and connected starter before generating template metadata. Core deployment uses the normal immutable release and scoped VPS rollout; copying unreviewed gateway code onto a running owner computer is outside this implementation's release path.

## Authentication, boundaries, and installation recovery

| Endpoint | Authentication | Public |
| --- | --- | --- |
| GET `/api/app-gallery` | Verified principal matching the configured owner of this home | No |
| POST `/api/app-gallery/:id/install` | Same owner principal; strict empty JSON body and safe catalog ID | No |
| POST `/api/bridge/query` with `compareAndSwap` | Existing authenticated app-data bridge and owner/scoped-app authorization | No |

The gallery API is supported on Linux owner runtimes. Filesystem reads and publication pin directory handles through `/proc/self/fd` and refuse symlink traversal. Node does not offer equivalent portable directory-relative operations on macOS; the API fails closed on local macOS runtimes until a safe platform capability exists. Electron Desktop on macOS remains supported when connected to its Linux Matrix computer.

Installers stage outside app discovery in `data/app-gallery-staging`, a subtree denied to ordinary file APIs and workspace grants. Exclusive publication never replaces existing files and publishes `matrix.json` last. Visible incomplete folders are retained after a failure rather than deleted using stale pathname identity checks; the owner must recover or rename an incomplete folder before retrying. Fixed staging slots bound retained staging state. Existing complete owner apps remain readable and unchanged.

The catalog is capped at 30 definitions. Template traversal is bounded by file, entry, depth, and byte limits; simultaneous installs are capped at two. Mutations use body limits and strict action schemas. The shared app-data bridge keeps its established body/time budgets. Browser requests have bounded timeouts and do not follow redirects.

Existing-record saves and archives compare the original JSON payload in the SQL write itself. A mismatch returns an explicit conflict, preserving the editor draft. Source imports must preserve owner-edited fields and may not send, label, publish, or modify source integrations. New-row retries reconcile a stable ID after an uncertain response. Active-record loading scans bounded pages and discloses when its coverage limit is reached.
