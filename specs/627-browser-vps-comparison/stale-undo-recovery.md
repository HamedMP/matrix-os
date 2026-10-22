# Recover a stale browser Undo view

Stack ticket: [MAT-6](https://linear.app/matrix-os/issue/MAT-6/add-browser-use-support-to-matrix).

## Observed problem

Two Web Desktop views can show the same saved browser grant. After the first
view revokes it, Undo in the second view is rejected safely by the authority's
revision check. The second view currently retains its stale Undo button and
shows a generic save error until the owner refreshes.

## Resulting behavior

After a failed Undo, perform one bounded authenticated read of that Chat's
current grant. Clear stale access when that read confirms no active grant;
show a replacement grant for review without automatically revoking it. Retain
the uncertain request identity when the same grant is still active, so an
explicit retry remains idempotent. Failed reads preserve the prior view and
show the existing generic error.

Ignore recovery results after the Chat, client or current grant observation
changes. Never project another Chat's grant. Share the refreshed observation
with sibling permission cards through the existing presentation context.

## Invariants and boundaries

- The server remains authoritative. No new grants, persistence, routes, proof
  inputs or authorization exceptions are introduced.
- Recovery reads never cause another DELETE. A changed grant needs a fresh
  owner click and a new request identity for its exact revision.
- Use the shared permission card in Web Canvas, Web Desktop and Electron
  Desktop. No renderer-specific business logic or styling is added.
- Propose engineering/product review alongside the existing browser stack.

## Verification and evidence

Six regression cases failed before implementation: externally revoked access,
replacement grants with the same/new ID, unchanged uncertain access, failed
recovery reads, and late responses after changing Chats. Run them with the
existing card and presentation-contract suites.

The originating failure is an actual signed Web Desktop test, documented in
the [review guide](https://github.com/HamedMP/matrix-os/pull/2583#issuecomment-6232562723).
That capture proves the defect, not the corrected UI. New-source live
qualification across affected surfaces remains pending; local development
servers and Electron stay closed at the owner's request.

Update the browser permission recovery guidance in the existing public-docs
[site PR](https://github.com/FinnaAI/matrix-os-site/pull/260) after validation.
