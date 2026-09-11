# Personal Brain integration foundation

This increment builds on the managed catalog, custom MCP broker, and runtime
approval contracts from #1410, #1411, and #1412. It does not implement the mail
application, durable ingestion, extraction, or scheduled jobs in the active plan.

## Contracts

- Gmail list/search and history preserve opaque page tokens. History IDs remain
  strings. An expired history request fails; callers must perform full resync.
  A machine-readable expired-history recovery contract is still deferred.
- Calendar and Drive preserve page tokens and filters. Drive requests
  nextPageToken and incompleteSearch alongside file metadata.
- GitHub exposes page/per_page, Slack exposes cursor or page/count as appropriate,
  and Discord exposes string before/after IDs. These actions return one provider
  page, not a claim that the complete dataset was fetched. GitHub callers must
  continue numbered pages until an empty page; this increment does not expose
  Link response headers.
- Pipedream action/account inventories traverse SDK pages, including in-place
  mutation of the SDK Page instance. Reads are bounded to 20 pages, 2,000 items,
  10 seconds per request and a shared 30-second deadline, without automatic
  retries. A failure or exceeded bound rejects the inventory rather than
  returning a partial list as complete. Credentials are not requested.
- Reviewed direct mappings take precedence over discovered components, preserving
  parameter contracts. Component-only actions remain supported. Static headers
  still come only from the registry, never caller input.
- Action validation runs at the route boundary and, for constrained actions,
  again at execution. Schemas are constraints-only and must not transform input.
- Gmail create_label and modify_message are write-risk actions covered by the
  existing native approval gate. Modify changes labels on exactly one message:
  remove INBOX to archive or UNREAD to mark read. No batch or deletion action is
  added, and TRASH label mutation is rejected.
- Nima's connector kinds, expansion catalog, static headers, approvals, and
  removal of unrestricted Linear GraphQL/calendar deletion remain intact.

## Security and ownership

All actions use the existing authenticated owner/connected-account routing and
provider proxy. No credentials, mail content, or account identifiers are added
to repository fixtures. This increment adds no endpoints, database tables,
background workers, or production schedules. Personal and organization scopes
must remain separate in future ingestion.

## Validation and rollout

Focused tests cover action mappings, invalid bounds and payloads, SDK pagination,
later-page failure, credential exclusion, direct/component precedence, and the
existing catalog approval map. The real SDK pagination test stubs only HTTP.

Before production enablement, run fresh CI and Greptile review across the stack.
On an explicitly selected test account, verify page two retains its filters and
one approved label/archive action reaches the intended message. Monitor existing
integration call errors and rate-limit responses during the first import.
Repeated page-one results, missing cursors, approval bypass, or cross-account
results block rollout; disable the importing job and revert the release if seen.
No production rollout or mailbox test is performed by this change.

Public documentation is a separate deliverable in FinnaAI/matrix-os-site under
content/docs/. Do not advertise a complete personal brain or inbox-zero product
until U2–U5 of the active plan are implemented and validated.
