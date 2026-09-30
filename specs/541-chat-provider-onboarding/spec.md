# Chat startup and provider onboarding (ENG-60)

Status: planning; implementation awaits user approval of the final plan.

## Goal and scope

New users should enter an open Chat and connect Claude Code or Codex directly from its empty state. The immediate request is startup and provider connection. Further integration onboarding and a broader visual redesign are deferred until their design is available.

The implementation must cover Electron Desktop's native Chat and the shared Web Desktop / Web Canvas Chat paths. Shared responsive Chat retains the same state semantics. Native Mobile startup redesign is outside this desktop request.

## Required behavior

1. On a normal runtime entry, wait for persisted OS-view restoration, then open the canonical Chat once only if it is not already open. An existing open Chat, including a minimized surface, is left untouched: no reopen, focus change, route reset, or draft loss. Explicit launch links retain precedence. Refreshes, switching presentations, ordinary renders, and a manual close must not trigger repeated reopening.
2. When fresh authoritative provider state confirms no provider is connected, show Claude Code and Codex connection controls in the empty Chat state. Reuse supported Settings connection actions, progress, and errors. Do not infer connection from installation or saved selection. Connected status and send readiness remain separate: a connected but disabled, unfunded, or unavailable route must not be mislabeled as disconnected.
3. Unknown, loading, and failed reads remain distinct from confirmed disconnected state. Keep draft composition available while sending remains governed by existing readiness/admission rules.
4. Refresh readiness after a connection action completes or the user returns from authentication. Provide bounded manual refresh recovery without restarting the application. Preserve drafts and immutable existing Chat bindings.
5. Any connected provider, including Matrix AI, Hermes, Pi, or another supported provider, suppresses connection onboarding even when Claude Code and Codex are disconnected. Preserve normal Chat behavior and its existing availability/recovery UI. Existing conversations must not be replaced by onboarding.

## Invariants

- Source of truth: gateway provider settings/catalog and readiness; persisted owner OS view and existing canonical launch contracts.
- Lock / transaction scope: no new database writes or persistence schema. Existing provider mutations remain server-owned.
- Acceptable orphan states: abandoned login attempts follow the existing expiry/cancel contract; no Chat/conversation is created just to render onboarding.
- Auth source of truth: selected-runtime authenticated transport and existing server permission checks. The new UI never handles credentials directly or manufactures shell commands.
- Resource policy: bounded requests, existing cancellation/stale-runtime guards, no new unbounded polling or registries.
- Deferred scope: integration onboarding, pending Settings Figma redesign, new provider auth policy, funding changes, deployment/merge, and Native Mobile startup changes.

## Acceptance and delivery

- Tests first for one-shot startup, restore ordering, explicit launch precedence, duplicate prevention, preserving active Chat/drafts, provider-state classification, and actual connection controls.
- Component integration tests must exercise native and hosted Chat empty states plus successful, pending, cancelled, failed, and stale-runtime authentication outcomes.
- Regression tests retain Settings connection behavior and usable alternate providers.
- Build and inspect the exact-head Electron Desktop with a fresh profile and restored state. Fixture evidence and live selected-runtime evidence must be recorded separately. Any backend change additionally requires matching Preview VPS validation.
- Deliver one primary implementation PR for ENG-60 and a companion public documentation PR in the private `FinnaAI/matrix-os-site` repository under `content/docs/`.
- Present an exact-head runnable Human Review flow. User Human Review approval precedes requested Greptile/final CI and landing gates; no automatic merge or production rollout is authorized.
