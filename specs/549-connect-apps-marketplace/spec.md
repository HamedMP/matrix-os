# Connect Apps marketplace

## Outcome

Rename the built-in Plugins launcher shortcut and integration Settings entry to **Connect Apps**. Keep `plugins`, `__plugins__`, and `services`/`integrations` internal identifiers stable, including recovery of old Plugins window titles. The separate local plugin/skill manager keeps its existing name.

Refresh the app catalog following the supplied Grokbot and ChatGPT references: search, quiet two-column app rows, logos, category headings, View all, Connected filtering, explicit Connect/Add account controls, and an OAuth-only filter. Use existing theme tokens and fonts; light and dark themes share layout. All catalog rows use verified Pipedream app-ID logos or official vendor assets (Granola); X retains its bundled SVG. An initial is only an image-load failure fallback, and a changed asset retries automatically. Account labels are editable after connecting rather than requiring an input before connection.

Expand the registry from 15 to 27 integrations. New apps: Asana, Airtable (the `airtable_oauth` connector), ClickUp, Todoist, Dropbox, Box, Microsoft Outlook Email, Microsoft OneDrive, Microsoft Teams, HubSpot, Zoom, and Google Slides. This increment exposes reviewed read operations only. Descriptions reflect those operations; write operations and arbitrary vendor actions are deferred.

## Catalog evidence and scope

Checked 2026-10-06: [Pipedream catalog](https://pipedream.com/apps) lists 3,223 apps and 14,946 tools. [Managed auth](https://pipedream.com/docs/connect/managed-auth/quickstart) handles provider consent and refresh. These totals describe Pipedream, not Matrix's supported catalog. Each added connector's public app detail page confirms OAuth, exact slug, proxy availability, and consent scopes. Airtable's key connector must never substitute for the OAuth connector. Outlook Email lacks Calendar.Read in its default consent; this release exposes mail and mail folders only.

Registry entries remain the execution allowlist. Do not expose all 3,223 connections without reviewed actions, validation, owner isolation, and revocation support. Broader consent scopes requested by Pipedream do not expand Matrix's action authority.

## Sources of truth and wiring

- Gateway registry owns supported services, connector slugs, parameters, and action risk.
- Shared contracts own app descriptions, authentication labels, category derivation, and search/filter behavior.
- Shared marketplace component owns Web Canvas/Web Desktop/Electron Desktop search, filters, grouping and row layout. Existing account controls and consent transports remain surface adapters.
- Native Mobile and Web Mobile consume the same catalog derivation and wire metadata; native layout uses one column.
- Exact provider slug resolution canonicalizes Airtable in signed webhooks, explicit sync, and call-time recovery. Unknown or alternate API-key slugs fail closed.
- Pipedream stores third-party credentials; owner-scoped connected-service metadata remains in the existing owner-bound Postgres/Kysely path.

## Auth matrix (existing endpoints)

| Route | Authentication | Change |
| --- | --- | --- |
| GET /api/integrations/available | Existing public catalog policy; scoped readers retain read projection | Description/auth metadata and twelve curated apps |
| GET /api/integrations | Existing resolved owner identity | Canonical service IDs |
| POST /api/integrations/connect | Existing resolved owner identity, bodyLimit + Zod | Existing consent token path with exact OAuth slug |
| POST /api/integrations/sync | Existing resolved owner identity, bodyLimit | Exact slug-to-service canonicalization |
| POST /api/integrations/call | Existing owner/account resolution and action validation | Reviewed reads, bounded parameters and fixed vendor hosts |
| POST /api/integrations/webhook/connected | HMAC, bodyLimit + bounded schema, existing admission policy | Exact canonical service resolution |
| DELETE /api/integrations/:id | Existing owner identity + bodyLimit | Unchanged deletion semantics |

No new endpoints, pools, or tables. Active identical reads share a bounded promise map (128 entries, 30-second expiry and oldest-entry eviction); completed data is never cached. Billable SDK executions have explicit deadlines and no automatic retries; management calls retain retries. New actions use strict schemas, bounded IDs/cursors/page sizes and encoded path segments; callers cannot supply target hosts or arbitrary continuation URLs. Related persistence uses existing idempotent database writes. Unconfirmed consent may leave a provider-side account temporarily absent locally; signed webhook/sync/call-time recovery reconciles it. Failed disconnect preserves the local account.

## Validation and deliverables

1. Test-first catalog expansion, validation and owner-bound action execution.
2. Database-backed connect -> sync -> call -> webhook and missed-webhook call recovery for Airtable's distinct OAuth slug; existing cross-owner isolation tests.
3. Shared component search, auth/connected filtering, empty state and one-click actions; consent window opens synchronously, reports popup blocking, and remains retryable.
4. Web Canvas/Web Desktop/Electron Desktop launcher and persisted path tests; native search and connection tests.
5. Rendered checks for light/dark, narrow widths and overflowing content. Component preview checked at 375/768/1440 pixels in light/dark with real logos loaded and no horizontal overflow. The actual Web Desktop Settings screen was also checked locally against a synthetic gateway on 2026-10-07: launcher navigation, loaded vendor logos, search, and 32px category column spacing pass. Both shell CSS entrypoints explicitly scan shared integrations. Full authenticated Web Canvas and Electron Desktop runtime checks remain release verification.
6. Companion PR in FinnaAI/matrix-os-site updates `content/docs/guide/integrations.mdx` with the truthful catalog and authentication flow.
7. Live OAuth and authenticated vendor reads require separately connected development accounts. Automated mocks and public metadata are not live authorization evidence. Do not claim live verification or deploy without it.

## Deferred scope

Full Pipedream catalog browsing, dynamic actions/MCP ingestion, native Granola OAuth support (the existing mobile consent parser accepts Pipedream URLs), Outlook Calendar's separate connector, writes for new apps, and provider-specific live consent verification. New apps have read capabilities; existing integrations retain their current actions. Greptile 5/5 is required before merge.

## Drive content and execution costs

`get_file` remains metadata. The new read-risk `read_file` action returns actual UTF-8 text/Markdown and bounded Workspace exports (Docs Markdown/plain text, Sheets first-sheet CSV/TSV, Slides text). Fixed Google targets pass through the owner/account-bound Pipedream proxy, with a total 30-second deadline, redirect rejection, a 16 KiB metadata limit and 512 KiB streamed content limit. Invalid IDs fail before billable calls. Unsupported formats, download restrictions, missing files, oversized content and rate limits return safe failures, never metadata or silently truncated text. Passing the source MIME type from `list_files` avoids a metadata round trip; Google still enforces file access. Contents are untrusted external data.

No paid retries occur invisibly for actions or proxy calls, especially writes. Concurrent identical proxy reads coalesce by owner, account, URL, parameters and headers; settled results are removed so refresh reads fresh data. Remove Slack's auth.test profile lookup because it can never populate an email. Existing accounts with missing emails use valid email metadata from the free account listing during sync, never repeat paid profile requests on every two-second consent poll. New-account enrichment may still make one paid profile call. Management/catalog/account listing remains credit-free under the current Connect pricing. Proxy calls themselves remain billable.

Validation: raw Markdown/Workspace export tests, byte/UTF-8/deadline/error bounds, server-resolved identity and cross-owner denial through ordinary and scoped call routes, no retry and concurrent-read tests. A read-only check against a connected production Drive account on 2026-10-07 returned nonempty Markdown through the new reader; no contents or credentials were logged. Existing installed runtimes do not acquire this action until this PR ships. Pipedream's usage endpoint rejected the deployment credentials, so precise invoice attribution remains unverified. Pricing reference: https://pipedream.com/pricing (checked 2026-10-07).
