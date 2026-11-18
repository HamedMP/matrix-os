# Shared app pending-write recovery — ENG-485

Ticket: https://linear.app/matrix-os/issue/ENG-485/fix-pending-write-recovery-in-shared-app-recipient-sessions

## Goal and failure

A member can read an app but an unconfirmed mutation leaves its form locked. The reference app calls `MatrixOS.collaboration.retryMutation()`, which the owner bridge exposes but the recipient iframe bootstrap omits. Check write therefore throws TypeError and never reaches the existing idempotent transport recovery.

Expose the same recovery method to recipients. Add a strict, payload-free retry frame that the exact mounted viewer routes to its existing transport. Reuse original mutation request IDs/revisions; concurrent app/overlay recovery shares one in-flight retry. Success clears the uncertain overlay, notifies the mounted document and returns its revision/result. Failures preserve safe errors and unconfirmed input. Late results cannot affect a replacement viewer.

## Security and wiring

| Boundary | Authority | Validation/bounds | Public |
| --- | --- | --- | --- |
| Existing authenticated launch HTML | Platform participant and current membership | Existing CSP, participant escaping and HTML limit | No |
| Iframe retry message | Exact current iframe Window and same/opaque allowed origin | Strict type + bounded request ID, no action/scope/actor payload | No |
| Existing owner mutation retry | Existing proof-bound transport, fresh membership, receipt and revision checks | Same saved mutation and client request ID | No |

No new endpoint, credentials, persistence, grants, or authorization fallback. Existing 32 pending iframe requests and 70-second deadline apply. One retry promise per mounted document is released on settlement and ignored after teardown. No customer app or records are changed by implementation/diagnosis. Extract the bootstrap from the 766-line routes file before extending it.

## Acceptance

| Actor/state | Action | Completion/failure | Evidence |
| --- | --- | --- | --- |
| Member, uncertain create | Check write via real injected API | Same request ID, replayed result returned, no duplicate create | Producer → viewer → transport regression, synthetic upstream failure |
| Member, repeated recovery | App and overlay retry overlap | One retry request, consistent reply | Same boundary test |
| Member, access ended/conflict | Retry | Generic failure, no successful recovery claim | Failure regression |
| Old document/viewer | Retry settles after switch | No reply or state change in replacement | Lifecycle regression |
| Member, no pending write | Retry | Existing conflict semantics, no invented mutation | Boundary regression |

Use existing auth/idempotency integration suites as affected tests. Run coverage, typechecking, React Doctor, patterns and applicable production builds. Record actual regression red/green. Update public app-sharing guidance in a separate FinnaAI/matrix-os-site PR. Recommend collaboration/runtime owner review of protocol and release order.

Web Canvas, Web Desktop, Electron Desktop and Web Mobile reuse this viewer; each needs exact-preview live recovery screenshot/recording before visual qualification. Native Mobile has no V1 custom-app runtime; N/A requires reviewer approval. Local fixtures do not establish live owner/member acceptance. Requester requires green CI and trusted current-head Greptile 5/5; do not merge or send Slack. Platform bootstrap and host viewer must both be updated for the new method; do not call the private reference app's initial mutation failure diagnosed by this recovery fix.
