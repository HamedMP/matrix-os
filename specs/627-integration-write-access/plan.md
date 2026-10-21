# Integration read/write access

Track under [ENG-91](https://linear.app/matrix-os/issue/ENG-91/validate-launch-integrations-end-to-end).

## Outcome

Restore Figma's official MCP authorization where the upstream permits Matrix as
a client. Preserve encrypted platform custody, PKCE, issuer binding, owner scope,
rotating-token concurrency fences and explicit tool approval. Never impersonate
another approved MCP client. Report upstream client approval as a real blocker.
Add bounded, validated write operations to the managed integrations that currently
only expose reads. Preserve read-only grants and services without upstream writes.

## Authorization

Existing owner-authenticated integration and Custom MCP routes remain the only
entry points. OAuth callback alone is public, protected by one-use expiring owner-
and server-bound state. No new public mutation routes. No automatic messages,
emails, payments, or destructive writes. Every new write uses risk=write and
existing approval enforcement; a read bearer must never acquire write authority.

## Units

### U1: Figma OAuth (parent)
Goal: diagnose actual registration failure and support documented OAuth client
authentication without leaking secrets or changing grant/tool policy silently.
Files: custom-mcp/oauth*.ts, broker.ts credential type, focused OAuth tests,
platform configuration only if required by observed upstream behavior.
Approach: exact-identity live spike, then failing regressions before changes.
Patterns: existing public-client OAuth, encrypted grant CAS, refresh claims.
Tests: registration rejection, HTML error responses, confidential client auth,
issuer changes, code exchange, token refresh and revocation, secret non-disclosure.
Verification: focused tests plus real owner sign-in/discovery and safe design-tool
validation if Figma grants Matrix access. User authorization remains required.

### U2: Task/CRM managed writes
Goal: bounded Asana, Airtable, ClickUp, HubSpot create/update operations.
Files: new integrations/task-crm-writes.ts and focused tests only. Parent wires
exported service/action extension map into registry.ts.
Approach: official current API contracts; strict Zod schemas, fixed hosts and
encoded identifiers. Do not use speculative Pipedream component keys.
Patterns: catalog-fields.ts, registry-oauth.ts, task-crm-depth.ts.
Tests: valid mapping, invalid IDs and payloads, bounds, write-risk and executor.
Verification: tests first, focused test run and type compatibility.

### U3: Document/calendar/communication managed writes
Goal: bounded writes for Google Contacts/Slides, Outlook mail/calendar,
OneDrive, Teams, Dropbox, Box, Zoom and Intercom where documented APIs support
them. Prefer creation/update of drafts, metadata, folders and records; no new
automatic sends or payments. User-requested sends still use existing approval.
Files: new focused integrations/*-writes.ts modules (excluding task-crm-writes)
and focused tests only; parent wires action-extension map into registry.ts.
Approach: official API verification, strict bounded schemas, fixed targets,
correct Graph paths and explicit risk. Do not add generic arbitrary-payload APIs.
Patterns: registry-catalog.ts, registry-oauth.ts, catalog-fields.ts.
Tests: API/body mapping, escaping, bounds, schema failures, write/read separation.
Verification: tests first, focused tests and type compatibility.

### U4: Existing unimplemented managed actions
Goal: implement Drive upload and resolve Jira/PostHog API-key mapping gaps with
real reviewed API contracts, or identify an actual setup limitation truthfully.
Files: google.ts, registry-expansion.ts, new action execution helper modules,
action-execution.ts if needed, focused tests only. No registry.ts or OAuth edits.
Approach: official API contracts and Pipedream proxy behavior, account-bound
execution; Jira cloud-resource preflight; no guessed component keys or hosts.
Patterns: catalog-bound-execution.ts, drive-read.ts, action-execution.ts.
Tests: missing mappings red first, payload/response caps, timeout and auth failures,
strict validation, no writes via a read capability.
Verification: focused tests and actual owner checks where already connected.

### U5: Wiring, review, docs and runtime qualification (parent)
Wire extension maps once without duplicating business logic. Run focused tests,
typecheck and security-pattern checks. Split PRs below 3,000 additions/50 files,
link ENG-91 and this plan, request current-head Greptile and label ready-for-ci on
5/5. A separate FinnaAI/matrix-os-site documentation PR updates supported actions,
reauthorization and provider limitations. Obtain required supported-surface live
evidence before merge readiness. Do not claim account writes from registry tests.

## Evidence and limitations

Private incident/account identifiers stay outside the public repository. Existing
active connections report empty scope arrays, which is unknown scope rather than
proof of write readiness. Figma REST/Pipedream default scopes omit file content;
canvas writes require the official MCP API. Granola's managed upstream contract
exposes read-only tools. Platform/native dependencies must fail truthfully.
