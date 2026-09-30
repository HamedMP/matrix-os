---
status: active
---

# Implementation units

## U1 — Native Slack installation, linking and ingress

Goal: one installable app with durable, safe identity and event delivery.
Files: platform/slack modules and focused platform tests; platform startup composition.
Approach: native OAuth, encrypted token store, hashed state/challenges, existing organization authority, metadata-only receipt leases, durable home acknowledgement.
Execution note: test-first.
Verification: forgery/replay/cross-workspace/duplicate/concurrent/timeout/revocation and native app API mapping tests.

## U2 — Explicit group Pi isolation

Goal: qualify company Pi runs through existing runtime, preserving private bot semantics.
Files: bot admission, orchestrator, runtime registry/broker, memory/integration tools, bindings and focused tests; startup/bots.
Approach: trusted group binding, fresh existing collaboration authority, separate root/session/audience, no private-memory/artifact fallback, group grant boundaries, every-frame reauthorization.
Execution note: test-first.
Verification: direct vs group privacy, revoked group broker denial, canonical lifecycle and root-fingerprint tests.

## U3 — Durable Company Brain sources

Goal: bounded source-linked company context on owner Postgres.
Files: gateway/company-brain modules and focused gateway/Postgres tests.
Approach: exact ownership/scope keys, existing collaboration authority, atomic revisioned publication, full-text retrieval, delete/export and citations.
Execution note: test-first.
Verification: cross-owner/org/source denial, mutation races, deletion, truthful provenance and restart tests.

## U4 — Runtime and outbound wiring

Goal: Slack invocation becomes a scoped canonical Chat run and an authorized thread reply.
Files: gateway/slack modules, startup extraction/composition, platform dispatcher wiring and end-to-end tests.
Approach: verified actor identity and target binding, canonical request IDs/queues/events, group dispatch through Pi scope runtime, exact destination outbox and publication reauthorization.
Execution note: test-first.
Verification: full HTTP ingress → home enqueue → canonical Pi → source citations → Slack reply, duplicate/uncertain/revocation/offline coverage.

## U5 — Review, documentation and pilot qualification

Goal: reviewable PR stack and truthful availability.
Files: feature setup/evidence docs; separate site repository docs PR.
Approach: focused/full relevant tests and type checks, independent security/code review, Greptile 5/5 on current heads, ready-for-ci label, selected pilot workspace/host live evidence.
Verification: record exact revisions, test outcomes, upstream dependencies and any remaining external setup/qualification. Merge only after review gates; clean completed worktrees only after verified merge and no unfinished work/processes.
