# Drive content reads and Pipedream execution costs

## Drive content and execution costs

`get_file` remains metadata. The new read-risk `read_file` action returns actual UTF-8 text/Markdown and bounded Workspace exports (Docs Markdown/plain text, Sheets first-sheet CSV/TSV, Slides text). Fixed Google targets pass through the owner/account-bound Pipedream proxy, with a total 30-second deadline, redirect rejection, a 16 KiB metadata limit and 512 KiB streamed content limit. Invalid IDs fail before billable calls. Unsupported formats, download restrictions, missing files, oversized content and rate limits return safe failures, never metadata or silently truncated text. Passing the source MIME type from `list_files` avoids a metadata round trip; Google still enforces file access. Contents are untrusted external data.

No paid retries occur invisibly for actions or proxy calls, especially writes. Concurrent identical proxy reads coalesce by owner, account, URL, parameters and headers; settled results are removed so refresh reads fresh data. Remove Slack's auth.test profile lookup because it can never populate an email. Existing accounts with missing emails use valid email metadata from the free account listing during sync, never repeat paid profile requests on every two-second consent poll. New-account enrichment may still make one paid profile call. Management/catalog/account listing remains credit-free under the current Connect pricing. Proxy calls themselves remain billable.

Validation: raw Markdown/Workspace export tests, byte/UTF-8/deadline/error bounds, server-resolved identity and cross-owner denial through ordinary and scoped call routes, no retry and concurrent-read tests. A read-only check against a connected production Drive account on 2026-10-07 returned nonempty Markdown through the new reader; no contents or credentials were logged. Existing installed runtimes do not acquire this action until this PR ships. Usage attribution was checked separately in the authenticated Connect billing dashboard; private customer details remain outside this public specification. Pricing reference: https://pipedream.com/pricing (checked 2026-10-07).

## Auth and runtime wiring

No new endpoints or persistence. Existing `/api/integrations/call` and `/read-call` retain owner resolution, account selection, body limits and action schemas. `read_file` is a read-risk action. Server-resolved owner/account values overwrite caller data before invoking the raw reader. Fixed Google hosts, redirect rejection, deadlines and byte bounds apply. Deployment must update the platform integration handler and app/kernel instructions; installing a UI alone does not change the action catalog.

## Deliverables and boundaries

Companion public documentation: FinnaAI/matrix-os-site PR #183. The independent marketplace work remains in Matrix OS PR #2217. Google Workspace export has mocked coverage; additional live reads require a named owner-approved file. No production deployment, credential export, subscription change, binary upload overhaul, or unidentified customer workload change is included. Greptile 5/5 and green CI are required before merge. The clock ordering test uses a fixed noon date to avoid unrelated runner-time flakes.
