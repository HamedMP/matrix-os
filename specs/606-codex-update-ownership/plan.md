# ENG-298 — local implementation plan

Ticket: https://linear.app/matrix-os/issue/ENG-298/codex-pinned-at-01561-on-customer-vpses-npm-i-g-openaicodex-lands-in-a
Existing PR: https://github.com/HamedMP/matrix-os/pull/2593

## Current scope and base

Resume the original worktree only. Preserve original checkpoint5ee65261, old publishedaadfe9b6 and the pre-rebase source/patch. Rebase local work onto maine8cc2cb1e19a6b0afc0d9e30490aaced9a8d8aaf; do not force-push the existing remote branch. Main#2657 already qualifies0.163.0 protocols but retains installer0.156.1 and scope0.154.0 pins. Preserve all Main protocol records and promote the shared managed executable consistently to0.163.0.

1. Write failing ownership/PM/consistency fixtures, implement the minimum repair, and record RED→GREEN.
2. Keep legacy Hermes config support. For v0.22 PM, select only validated active owner-local Node/npm entries from bounded schema1 facts. Never mutate their digest-bound trees or recorded facts.
3. Put the Matrix PM default outside the store. Activate it only in fresh non-root Matrix owner environments when no explicit environment/owner globalconfig choice exists. Bound the read-only npm config probe; reject symlinks/path escapes. Preserve private tool links, owner/project prefix settings and CLI overrides.
4. Retain exact recognized local Codex shim migration, atomic replacement and the failed-pack retry fix. Ship helper in the explicit bundle allowlist.
5. Run copied-real-PM Node/npm process fixtures without installation or credentials, affected regression suites, native typecheck, shell syntax and pattern checks. Obtain independent local read-only review and fix its findings.
6. Save a local candidate, English cases, immutable receipt and recovery bundle. This round authorizes no push, new CI, external review, model/provider call, installation, GUI, Private repository, Slack, machine/service mutation, merge or substitute task.

## ENG-306 ownership

ENG-298/#2593 owns the single npm reconciler and owner-environment activation. ENG-306's original author alone owns the Hermes upgrade flags, managed Python resolution and credential compatibility. Its installer must retain the shared reconciler hook after successful provisioning; no copied implementation. Standard native Hermes inherits the owner environment via hermes-stdio-client. Restricted profiles remain unchanged and do not inherit that environment. Custom PM payload/runtime overrides are not claimed supported.

## Deferred qualification and landing

An exact0.163.0 scope-process fixture remains required before landing; this local round supplies no new native CLI and explicitly skips that opt-in test. User account model visibility, native Linux isolation, live Hermes/browser surfaces and rollout need separate coordinated acceptance. Main removed automatic Claude review in#2666; do not reuse the old push-side-effect statement. Publication remains separately authorized, with current-head review/CI and a non-author approval last. Public docs coordination in FinnaAI/matrix-os-site is a separate deliverable, blocked this round by the explicit no-Private/no-publication scope.
