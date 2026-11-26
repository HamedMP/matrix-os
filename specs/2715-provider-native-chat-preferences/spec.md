# Provider-native Chat preferences

Ticket: [ENG-404](https://linear.app/matrix-os/issue/ENG-404/preserve-chat-effort-and-permission-when-switching-providers).
Implementation: [plan](plan.md). Evidence: [validation](validation.md).

## User outcome

Chat remembers model, effort and permission defaults separately for each provider
instance. Switching Claude → Codex → Claude, opening a new Chat and reloading
restores that instance's choices. An explicitly picked model overrides the saved
model. Unsupported saved values fall back to the destination catalog defaults.

## Controls

- Codex: Ask for approval (human reviewer), Approve for me (automatic reviewer),
  Full access. Automatic review keeps the workspace sandbox.
- Claude Code: Manual, Accept edits, Auto, Don’t ask, Full access. Effort includes
  low, medium, high, extra high and max as supported by its catalog.
- Existing plan/review interaction controls remain separate. Other providers keep
  their existing capabilities and catalog-authoritative option validation.

## Persistence and compatibility

Use the existing Desktop preference store and a bounded Web per-instance
configuration map. Preserve the legacy single Web selection on first switch.
Mounted composers observe preference changes; sequential writes from stale tabs
must preserve independently saved providers. Browser storage is not an atomic
cross-tab transaction: truly simultaneous writes remain last-writer-wins.
Historical Codex Auto/Accept edits retries migrate to human approval, never to
an automatic reviewer. Preserve the original run's audit record. Unsupported modes
remain unavailable for newly submitted turns.

## Authority and wiring

No new routes or credentials. Existing owner admission and provider account
bindings remain the auth source of truth. Revalidate selected modes against the
catalog at admission. Carry Codex reviewer and sandbox through launch, resume and
each accepted turn. Preference changes alone do not modify active work.
No new database writes, transactions, locks or orphan resources are introduced.

## Completion checks

1. Distinct provider defaults survive switching, new Chat and reload; unavailable
   account/model states retain existing behavior.
2. Each permission choice reaches its native runtime, including a same-process
   switch back from automatic to human review.
3. Historical retry and stale-tab regressions pass against production boundaries.
4. Live current-build screenshots and recordings qualify Web Canvas, Web Desktop,
   Electron Desktop, Web Mobile and Native Mobile separately; any N/A requires
   rationale and reviewer approval. Fixtures do not qualify a surface.
5. Attach evidence to the PR and share the required tech-channel evidence link.
   Obtain engineering/product review for changed permission semantics.
6. Create the separate public documentation PR in FinnaAI/matrix-os-site under
   content/docs for native modes and independently remembered defaults.

## Scope limits

No deployment, merge, provider installation, new account setup or existing Chat
history rewrite. Live qualification and the public documentation PR are pending;
this implementation PR remains draft until review-readiness gates are satisfied.
