# Live Gmail runtime repair

Tracking: [ENG-355](https://linear.app/matrix-os/issue/ENG-355/prepare-gmail-oauth-verification-and-casa-evidence).

## Goal and boundaries

Repair tool-result continuation and reach normal authenticated owner consent for an attachment-free Gmail text read. Preserve the existing processor/model, recipient evidence, budget, expiry, account selection, and human consent requirements. This repair does not settle unknown provider usage, waive charges, create credentials, or change admission ceilings.

## Implementation

1. For the existing managed GPT-OSS route only, serialize absent/null assistant text as an empty string. Preserve tool IDs, arguments, results, deliberate text, and other models. The published model template tests membership in assistant content and does not accept null at that guard: https://huggingface.co/openai/gpt-oss-20b/blob/main/chat_template.jinja. This explains a reproducible compatibility hazard; the original upstream rejection still needs live confirmation.
2. Derive collection kinds from a closed action map in trusted host composition and independently on the receiving platform. Unknown actions fail closed. Full-message and attachment reads continue to require attachment permission.
3. Add `get_message_text`, a bounded native read. First request the selected immutable message's MIME tree without body data. Refuse filenames, attachment IDs, non-text leaves, malformed/deep/oversize trees, or data unexpectedly returned during preflight. Only an attachment-free MIME tree permits a second, independently authorized content request. Require the same message ID and MIME structure before releasing its result. Refuse this action through legacy transports until separately qualified.
4. Preserve the financial reservation and audit evidence. Existing operator execution recovery is independent of settlement and requires exact terminal-run and maximum-liability evidence. Do not invoke it before the failing request path is repaired and its existing contract is qualified.

## Authorization and wiring

| Boundary | Authority | Checks |
| --- | --- | --- |
| Owner tool to collection client | live owner/run binding | registered action, canonical account, actual owner interaction |
| Host to platform collection receiver | existing machine signature and signed owner | exact request bytes/path, one-use nonce, action kinds covered by reviewed profile and consent |
| Native Gmail text preflight and content | existing owner/account OAuth, existing before-send lease | fixed Google origin/path, no redirects, bounded response, deadline, revalidation for each send |
| Funded continuation | existing qualified relay | unchanged route and spending admission; no direct provider credential access |

## Verification

Write failing regression tests first. Cover tool-only null/omitted text, unchanged messages and other models; attachment-free MIME and multipart trees; attachment/unknown/deep/oversize/dishonest metadata; withdrawal between requests; message/MIME mismatch; closed action map and receiver refusal before nonce consumption or dispatch. Run focused gateway/integration/proxy tests remotely and type-check affected packages. Verify the actual pilot consent/read/label/withdrawal flow before claiming live completion. Recording follows successful live tests.

## Delivery and documentation

Ship the source through the existing Gmail stack PR, with exact source/test evidence and scoped pilot deployment. Preserve unrelated worktrees and public-safe evidence. Update the canonical Gmail help in a separate site-repository PR for the attachment-free read behavior; it must not claim that an attachment-bearing message can be summarized through this path. Keep remaining runtime/device/processor evidence gates explicit.

## Temporary-label cleanup

The approved label lifecycle also needs a native-only `delete_unused_label` action. It is destructive and keeps the normal explicit owner action approval. Require an exact custom label ID and expected name, preflight its user-label type and empty message/thread counts, make one fixed-target DELETE attempt with no body or query, then require an independently admitted 404 readback. Each send shares one end-to-end deadline. Refuse system labels, mismatches, in-use labels, legacy fallback, and uncertain deletion results. Never retry a mutation after an unknown result; reconcile with reads.

Google offers no atomic empty-only delete, so an external concurrent label change remains a provider race. The pilot targets only the new test label recorded by its own create result, after removing it from the selected thread and checking it is empty. Preserve all preexisting labels and message/read state. This adds no OAuth scope or processor/profile permission. API reference: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/delete.

Test metadata mismatch/in-use/system/path attacks, withdrawal at each send boundary, native-only dispatch, one mutation attempt, empty responses, and exact 404 absence proof. Add the action to full catalog regression coverage and the public help draft.


### Human consent deadline repair

The live pilot reached the real Gmail consent card, but the external tool's
30-second dispatch deadline cancelled the ten-minute human wait. Gmail processing
consent now runs inside the broker's existing bounded approval preflight, before
an external-effect checkpoint. Dispatch revalidates current processing authority
without another prompt and refuses revoked or changed consent. Provider network
deadlines, profile scope, budgets, and expiry remain unchanged. Conservative
context marks may remain if a later admission fails; they contain no email body.

### Processing-request pacing

The saved-consent pilot reached the platform's per-handle burst limit during
repeated inventory, catalog and processing-authority checks, before the provider
read. Pace requests in each existing host transport at least 600 milliseconds
apart, with at most sixteen outstanding requests, four active fetches and the
caller's original abort deadline. Keep platform limits and every authority check
unchanged. Serialize actual starts so an event-loop stall cannot release overdue
requests as a burst. Slow responses retain an active slot without holding the
start queue while other capacity remains; background sync must not delay account
checks until its response arrives.
Snapshot the reviewed target and claim before waiting; sign the exact request
only when dispatched and refuse authority that expired while queued. Never retry
a response or an uncertain write. Separate transport instances still share the
authoritative server limit and may receive a refusal under concurrent load.

Regression checks exercise the unchanged platform guard, bounded overload,
cancellation and recovery, exact target/signature preservation, queued expiry,
and the real broker/owner-tool/checkpoint flow with disposable PostgreSQL. The
broker fixture uses synthetic consent authority and provider responses; live
selected-thread and label qualification remains required.
