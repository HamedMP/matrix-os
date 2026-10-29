# ENG-93 Main integration

Tracking: [ENG-93](https://linear.app/matrix-os/issue/ENG-93/enable-and-validate-recurring-tasks-on-the-launch-agent).

Preserve the verified candidate3b88ef2ba8f679c2f17af8601014242216ceb419 in its original worktree. Integrate in a separate persistent worktree on fixed latest Mainbe6cce1404bfd6db3392c535bca2e0def32ec577. Do not borrow old candidate test results for this source tree.

## Conflict decisions and security invariants

- Retain both contract/tool sets: Main shared Browser/tool-display functionality and personal routine contracts. Preserve Main browser approval registration/control imports alongside retained-thread queue guards.
- Main group runs keep bounded group resolution/authorization/routing, actor/root/signal and execution-generation checks, group capability allowlists, cancellation/deadline handling, and no access to private memory/history/uploads/executor fallback.
- Personal interactive runs may offer routine propose/control only when configured. Background and group runs cannot obtain these tools. The dispatcher independently rejects shared bindings before exposing or mutating personal routines.
- A background task bound to anything except a direct personal Bot Chat fails before group resolution, task mutation or worker admission. Preserve exact subscription/account/grant background consent; no alternative funding or key fallback. Keep only proven pre-worker capacity failures eligible for existing bounded retry.
- Retain Main shared-attachment source/root/membership/grant checks both before transport and before exposing bytes. Pass the transaction executor as the fourth qualifySource parameter, preserving Main's third sharedAttachment flag. The locked grant/source checkpoint releases before transport; failures after reads expose no bytes.
- Startup retains Main recovery plus routines in host/no-host return paths and existing shutdown drains. No permission, credential or grant is created by integration.

The existing520-line task orchestrator remains focused on one run lifecycle. Further lifecycle behavior should first extract source preparation and admission into focused helpers; preserve registry ownership, cancellation and shutdown. The existing canonical Chat orchestrator extraction plan remains in the retained-thread guard spec. This integration adds no runtime framework.

## Verification plan

1. Materialize fixed Main source in the isolated worktree. Use worktree-local sparse configuration; preserve original worktree settings. Reuse dependency caches without installing or modifying shared dependencies.
2. Resolve each conflict explicitly; preserve both branches' assertions. Run syntax checks and current-worktree-only package aliases/types, never stale source from the original worktree.
3. Test-driven combination fences: reject forged group background tasks before writes/admission; reject group routine RPCs before listing/proposing/controlling. Positive controls cover personal interactive capabilities, background restrictions, Main shared attachment pre/post-revocation with locked executors, group cancel/deadline and no-host/shutdown.
4. Run necessary combined unit/regression suites and strict types, including complete typed fixture structures. Update the migrate:false helper's expected registry to1–10; keep its empty-template/isolation assertions unchanged.
5. Replay original44 actual PG cases plus retained-thread4 and migration4 on this integrated tree, with exact source hashes and the approved resource-limited disposable PG16 runner. Preserve all prior evidence; stop only this round's test container and verify noOOM/no running remainder.
6. Independently review the final integrated diff, safety fences and raw results; commit only the reviewed integration changes locally. No push/CI/Greptile/deploy/merge authorization is implied.

## Release boundary

This remains personal routines only. No real jobs/models/mail, actual grants/credentials, production data, daily Matrix App, Runtime QA63022 or other task profile use. No GUI/live acceptance is claimed. v10 requires a compatible reviewed rollback build; never rewrite owner migration records.

Before publication, plan a native GitHub stack for the existing branch's size under repository limits; retain ENG-93 across layers. Request separate publication authority if the original no-push restriction remains. Current-head CI/review, approved runtime/client/device acceptance and a separate matrix-os-site public documentation PR remain release deliverables. Suggest engineering/integration-owner review of the shared/private source and rollback boundaries.
