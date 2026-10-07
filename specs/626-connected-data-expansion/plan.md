# Connected data expansion

User request: implement the integration gaps for the 92-app catalog, Bokio,
HubSpot, PostHog OAuth, Loops, lemlist, and selected uploads from phones and
computers. The user subsequently deferred device connections and the new selected-device upload flow. This release covers app integrations and owner imports; device work is retained separately for later. This is capability work, not implementation of all 92 researched apps.

## Reviewable stack

The integration release ships as three Graphite layers, each below 50 changed files and 3,000 additions:

1. OAuth broker, managed PostHog/Loops/lemlist, and company-bound Bokio.
2. Provider catalog, real icons, and deeper account-bound actions.
3. Owner-scoped durable imports, budgets, and agent orchestration.

The selected device upload/previews layer is deferred and excluded from this release.

Each layer has its own tests, PR, Greptile review, and rollback boundary. The canonical documentation PR describes only the active integration release.

## Shared invariants

Credentials remain owner-scoped and encrypted in the platform broker. Callers
cannot override the bound account. Apps require declared integration permissions;
read paths cannot invoke writes. External calls have deadlines and byte/page caps.
No automatic marketing sends, payments, or destructive changes. Existing approval
paths apply to write actions. Imported app data uses owner-controlled Postgres.
Device connections, selected uploads and native picker changes are excluded from this release.

OAuth is preferred when supported. HubSpot already has OAuth. PostHog and lemlist
official OAuth MCP servers need real discovery and execution wiring. Bokio needs
registered client credentials; report setup readiness truthfully. Loops uses its official OAuth MCP server with client-ID metadata discovery. Existing PostHog API-key connections remain distinct.

## Authorization matrix

| Route family | Authority | Public |
| --- | --- | --- |
| integration connect/call/disconnect | existing authenticated owner gateway and platform broker | no |
| OAuth callback | one-use expiring state bound to owner, runtime and exact redirect | callback only |
| app-scoped integration reads | authenticated read bearer, immutable connection binding and declared app permission | no |
| owner data-import refresh, source/page reads and deletion | selected-computer owner bearer plus installed app declaration; generated-app sessions denied | no |
| OAuth client metadata | fixed GET response, no user or credential data | yes |
| URL preview | authenticated owner, pinned public-address validation, no redirects | no |

## Implementation units

### U1: New standard service APIs
Goal: executable OAuth Google Contacts, Outlook Calendar, Google Sheets,
QuickBooks, Xero, Zendesk, Intercom; Loops curated read support (official native OAuth MCP).
Files: CREATE gateway integrations/registry-catalog.ts and focused helper modules;
CREATE tests/gateway/integration-catalog-expansion.test.ts. No edits to registry.ts,
registry-logos.ts, contracts presentation, or lockfile (parent owns wiring).
Approach: verify official API/auth and Pipedream slugs, use strict bounded schemas
and direct API requests to avoid paid component execution. Export catalog registry.
Patterns: registry-oauth.ts, registry-expansion.ts, list-validation.ts, types.ts.
Test scenarios: URL/body/schema mapping, invalid IDs/ranges/pagination, risk flags,
no arbitrary hosts, all new services executable, account-bound execution contract.
Verification: focused tests and type compatibility, document primary references.
Execution note: tests first. Shared-directory fallback; no staging/commits/suite.

### U2: Existing source depth
Goal: Gmail attachment reads, Notion child block reads, Calendar discovery,
Todoist create/update/complete, richer GitHub PR/check/review reads, Stripe payouts,
refund/reconciliation reads, HubSpot record/activity depth.
Files: MODIFY gmail.ts, google.ts, registry-oauth.ts, registry-expansion.ts,
action-execution.ts; CREATE focused integration-depth helper modules and
tests/gateway/integration-source-depth.test.ts. No registry.ts, contracts, logos,
custom-mcp, platform, or device file edits. Parent wires GitHub action extension.
Approach: bounded direct calls, strict schemas, binary attachment cap, account binding,
read/write separation. Avoid duplicating developer detail actions already shipped.
Gmail attachments remain capped at 1 MiB decoded. The shared read client permits a
1.5 MiB JSON/base64 response envelope only for read-only `gmail.get_attachment`;
other action envelopes remain 256 KiB. Owner refresh keeps its separate 512 KiB
page budget and may refuse a larger inline attachment. Reading/importing a file
does not start AI processing automatically.
Patterns: Drive read_file bounded execution, list-validation.ts, existing depth tests.
Test scenarios: valid/invalid IDs, byte/page caps, denied writes from reads, failure
and timeout behavior, complete action-to-executor integration.
Verification: focused tests and compatible existing integration tests.
Execution note: tests first. Shared-directory fallback; no staging/commits/suite.

### U3: Selected device imports across views (deferred)
Goal: selected file/photo upload from iOS/Android and browser/macOS desktop to the
selected Matrix computer, plus CSV/export and PGN ingestion foundations.
Files: existing gateway file route/upload helpers and tests (not integrations/*),
apps/mobile file request/browser UI and focused tests, shared file contracts,
shell file browser and Electron Files upload UI. New focused device/import helpers.
Approach: reuse bounded authenticated file upload path; native document/system
pickers only, no background photo access/HealthKit/AlarmKit entitlements. Preserve
filename/path guards, safe errors, progress, retry, cancellation and selected runtime.
Patterns: server/file-routes.ts, file-blob-routes.ts, Electron file-upload-controller,
mobile lib/requests/files.ts and matrix-files.ts.
Test scenarios: owner/runtime selection, CSV/PGN/photo/file upload, invalid names,
size limits, network failure leaves selection recoverable, mobile/web/desktop parity.
Verification: gateway/client tests and mobile types; note required dependency to parent
instead of modifying package.json or lockfile concurrently.
Execution note: tests first. Shared-directory fallback; no staging/commits/suite.

### U4: Native OAuth broker and marketplace wiring (parent)
Goal: Bokio OAuth company binding and refresh, official PostHog/lemlist OAuth,
Granola app-scoped reads, real provider icons and catalog presentation across views.
Files: platform managed preset/broker modules; gateway custom-mcp/oauth, read-call,
registry.ts/registry-logos.ts/types if needed; contracts/integration-marketplace;
logos assets and focused tests. Dependency/lockfile edits parent only.
Approach: generalize proven managed broker, discover actual tool schemas, use
approved read allowlists, fail closed on missing setup/tools. No fake OAuth.
Tests: state reuse/expiry, wrong owner/company/runtime, refresh rotation/concurrency,
unknown tool denial, read scope enforcement, exact discovery integration wiring.

### U5: Bounded import refresh and URL intake (parent after U1-U4)
Goal: resumable incremental source refresh with caps and backoff, shared safe URL
preview, and import metadata that supports the researched workflows.
Files: focused new gateway refresh/import modules, contracts, tests, dependent wiring.
Approach: owner Postgres durability, bounded pages/bytes/credits, no automatic paid
fallback/retry, explicit selected source; safe public-host URL resolution and pinned
fetch, no redirects. OCR uses explicit existing model approval path and limits.
Tests: cursor recovery, duplicate ingestion, concurrent refresh, expired/removed
connection, budget exhaustion, SSRF/redirect/oversize denial, no hidden paid calls.

### U4B: Bokio OAuth (source-depth worker after U2)
Goal: owner-bound company OAuth and safe Company API read actions.
Files: CREATE platform bokio-integration.ts, bokio-oauth.ts, bokio-preset-broker.ts
and tests/platform/bokio-oauth.test.ts only; parent owns all dependent wiring.
Approach: registered public integration credentials; fixed Bokio authorize/token/API
hosts; encrypted existing broker rows; one-use expiring state and refresh CAS;
tenant_id returned by grant is immutable; no fabricated public-client registration.
Tests: connect, company binding, token rotation, state expiry/reuse/concurrency,
missing registration, owner isolation, caps/timeout/failures, unsafe action denial.
Execution note: tests first, shared-directory constraints as U2.

### U6: Verification and shipping (parent)
Goal: test all units, run relevant checks/builds, preview and review, create Matrix
PR and separate private matrix-os-site documentation PR. Greptile current head 5/5
then ready-for-ci label; do not merge/deploy without applicable authorization.
Tests: meaningful focused + cross-layer security/parity checks; CI and visual evidence.

## Parallel safety

U1-U3 file sets do not overlap U4. Any newly needed overlapping file must be handed
to the parent before editing. Limited disk space prevents isolated dependency trees;
workers use the shared-directory fallback and do not touch git index or run suite.
Parent runs RED for staged test files before each implementation step, or authorizes
focused test execution serially to avoid test interference.

## Explicit deferred device scope

HealthKit/Health Connect, AlarmKit/exact alarm permissions, passive device library
sync, app extensions and automatic Hevy/game engines remain later as the user
allowed. Device connections and selected exports/photos/files are all deferred; no new native modules, binary version bump or device permissions ship with this release. App Review
acceptance cannot be guaranteed; privacy copy reflects only shipped behavior.
