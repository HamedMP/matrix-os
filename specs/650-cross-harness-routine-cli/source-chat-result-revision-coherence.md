# Keep source-Chat revision current after routine results

## Observed boundary

A live matching-version source Chat received successful routine results before an owner submitted the next routine-control message. The send retained the draft and reported that the Chat changed before the message was sent. The intended CLI archive was not observed. The test was cleaned up through the existing owner management UI, retaining its history; that cleanup is not CLI archive acceptance.

Investigate the exact producer/subscriber contract before fixing it. A separate old value copied into an assistant's `show` JSON remains unclassified because the completed native tool's stdout is not currently exposed by its command-only activity card. Do not treat that copied value as proof of a backend cache defect or mix it into this revision fix.

The isolated real-Postgres writer, canonical stream and actual Web hook reproduce two preparation races: the client accepted committed revision 4 while either an attachment upload or the actual attachment-free Full Access scope read was awaited, but admission still submitted captured revision 3 and the real repository rejected it. The writer already publishes the committed update. These tests establish the preparation defect at both boundaries; they do not establish the sole cause of the historical archive attempt.

## Required behavior

- A committed routine result in its original Chat must participate in the existing canonical Chat update flow. The current Chat's accepted metadata and revision must reflect committed external messages before the next owner turn uses that revision.
- Reuse the canonical persistence, transaction, notification and client reconciliation paths. Publish only committed state, scoped to the actual owner and Chat. Preserve original-Chat result attribution and the existing Bot execution history.
- Preserve an unsent draft, selection and permission state during reconciliation. Fence old Chat, authority and request completions; updates for another Chat or an obsolete authority must not replace the active detail or its draft.
- Before the first admission dispatch, use the latest accepted record for that same Chat and authority after asynchronous preparation, preserving the actual admission intent and binding constraints. Once an attempt may have been dispatched, keep its pinned request immutable; a later record update must not silently rebase an uncertain attempt. In-flight server CAS conflicts remain explicit failures, not an automatic retry guarantee.
- If preparation fails before any possible dispatch, release its preparation reference and discard the entry only when no other preparation, bound request, in-flight call, uncertain result or accepted receipt still owns it. Repeated authority failures must not exhaust the existing bounded tracker; concurrent preparation must not lose a later uncertain request.
- Keep optimistic revision checks. Do not remove CAS, blindly resubmit a message after an uncertain response, rebase a routine-control revision, replay an unknown request or occurrence, or create another schedule as recovery.
- No new auth mechanism, scope, token, identity claim, endpoint, MCP service, scheduler, database, global background grant or Settings schedule switch. Source permission, owner schedule activation, model consent and integration rights remain independent.

## Test-first evidence

1. Reproduce a meaningful failure using the real affected writer/notification/client seam: accept source detail, commit an external routine receipt, then prepare the next owner message. Demonstrate the stale revision or missing notification before production changes.
2. Prove committed result metadata reaches the current client and the next message uses the accepted current revision. Keep the transaction and owner/Chat scope real; synthetic transport is not live acceptance.
3. Cover duplicate receipt delivery, rollback/failure without a success publication, wrong Chat, changed authority and concurrent unsent draft. Add only relevant tests at the actual responsibility boundary.
   Cover repeated pre-dispatch authority failures, a failure while another preparation is pending, and preparation failure on an existing uncertain request. These cases must retain drafts and immutable requests without exhausting or bypassing the existing request bound.
4. Run affected tests/types/patterns and independent review. A fixture-only failure is not Red. If the proposed notification gap is not reproduced, report that and investigate the evidence rather than implementing a guessed fix.

## Delivery

Use an independent manual worktree and Draft PR above exact `f0a7985b0cd78ce37c6b6b91030cc0f4741096ff`. Reuse the existing Trellis task and public guide PR. Main owns this spec, task/handoff, commits and live operations. Exact new builds and a complete real CLI lifecycle, including CLI archive after source-Chat results, remain required before the English demonstration.
