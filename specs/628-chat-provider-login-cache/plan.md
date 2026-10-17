# Chat provider cache after login

Continuation: ENG-318 / Draft PR #2691 now exists. The a851 checkpoint is published; the separate local Codex cache follow-up and exact producer dependency are documented in [codex-cross-pr-contract.md](codex-cross-pr-contract.md). Old external-publication restrictions below describe the author checkpoint. Current order is local code/contract tests, coordinated matching-version machine evidence, human review, then Greptile/formal CI/Ready only if the user explicitly requests them.

Goal: make an already-open Electron Desktop Chat observe a confirmed connection immediately while retaining ordinary session caching.

Base: `8ac1c311554eb0700032d6e5eff0f63da09f9a53`. Related completed contracts: ENG-168, ENG-178, ENG-222. Linear creation was rejected because the tool catalog changed after preparation; no success receipt or new issue ID exists. One read-only title query returned no exact match. No retry or PR publication while this remains unresolved.

- [x] RED: reproduce stale/overbroad login refresh with synthetic Settings receipts and mounted Chat consumers; include duplicate/failed/cancelled receipts, identity changes and older requests.
- [x] GREEN: carry the exact successful workflow through the existing connection refresh, invalidate only its harness routes, and request a silent non-forced catalog projection. Keep manual refresh/revocation behavior and existing cache scheduling.
- [x] Treat ChatGPT plan as separate device IPC authority: detect accepted changes without treating native Codex, Claude, and plan accounts as interchangeable. Native Codex login remains capability-gated on this base; this task does not restore the pending native-login PR.
- [x] Verify focused tests, affected types/patterns, and one independent local read-only review. Original agent alone writes source. See validation.md.
- [x] Prepare public documentation text in public-docs-draft.md for a separate matrix-os-site draft PR when external publication is authorized and workflow costs are resolved.

No provider/model calls, credential reads, OAuth, GUI, runtime/deployment changes, CI, Slack or merge. Only synthetic mocks; local tests are not live visual acceptance. Required live surface evidence and production builds remain deferred under this task's explicit restrictions. Inspect current workflows (including #2666) before any publication; keep a local reviewable patch if publishing would trigger unapproved costs. Future Main synchronization uses rebase.

Invariants: the gateway remains admission authority; session memory stores only nonsecret projection/receipt IDs; successful login is a read trigger, never optimistic availability. Identity and epoch fences must reject obsolete responses. Failed refresh retains labels and suspends only affected routes. No new periodic timers or provider capability changes.

Review corrections: confirmed Claude workflow completion evicts only the owner's existing Claude inventory/health caches before publishing success. Account replacement cannot carry a five-second old inventory into the five-minute renderer cache. In-flight and queued explicit refresh intent survives login supersession. Cancelled login receipts update local workflow state without full Settings/catalog renewal.

Gateway composition stays in the existing focused `runtime-provider-catalog.ts` and `native-provider-workflow-runtime.ts` modules. The large `server.ts` gains only dependency wiring between them; further behavior belongs in those extracted modules (existing entrypoint extraction plan: specs/536-conversational-bots/plan.md#gateway-entrypoint-extraction). No endpoint, auth policy, database, or deployment change.
