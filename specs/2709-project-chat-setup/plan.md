# Project Chat setup implementation plan

Approved specification is [spec.md](spec.md). Tracking is ENG-538 and draft PR #3572. User authorization covers implementation, tests, a new owner-only Private Preview, Electron Desktop/Web Desktop/Web Canvas acceptance and screenshots, with no merge or production rollout.

## Reused architecture

Use canonical Chat PostgreSQL storage, request identities, revisions, transcript, outbox, model selection and admission. Add a focused Chat-owned setup draft row and typed API because existing strict metadata exposes no draft field. Keep project files authoritative for saved configuration. Reuse project admission, pinned-directory exclusive creation, full Markdown editor, existing Skill validators and source readers, shared project inventory and slash picker, and current-computer MCP Settings.

The first purpose answer creates the canonical setup Chat and draft transactionally. Server-validated transitions append the known next question and accepted answer to that Chat. Full Markdown drafting runs through existing canonical admission under an enforced supported review/plan mode. Parse and validate its bounded result as a staged proposal. Explicit Save publishes reviewed files through the existing pinned creation primitive. Return per-file outcomes and preserve partial successes.

The draft carries scope and a revision-bound reviewed proposal. Before each operation, resolve owner/project/root from trusted server context. Switching UI authority cancels requests and rejects late responses. Root, model capability, or answer changes invalidate affected confirmations. Existing-file edits continue through the exact existing editor.

## Ownership and composition

Backend/contracts implementer owns typed contracts and exports, setup schema/repository/service/routes, narrow registration seams, and contract/Gateway regressions. Frontend implementer owns shared setup client/hooks/actions, project Guidance viewer, Electron and Web entry/composer/transcript integration and UI regressions. Main session owns specification, tracker, environment, PR/CI, Private Preview and evidence.

Extract focused modules before adding behavior to large composition files. CanonicalChatWorkspace and ChatApp get minimal seams into extracted hooks/components. Chat repository, database bootstrap and route files delegate to focused setup modules. Use normal transcript rendering for assistant and user messages.

## Ordered verification

1. Write focused failing tests for server transitions, singleton/request idempotency, durable resume, revision conflicts, authority and primary-root isolation. Add tests for read-only model admission and validated generation results.
2. Implement the backend contract and transcript persistence. Test no data creation on the initial Skip, stale/moved/shared roots, existing/oversized/symlink destinations, each partial save point, concurrent creation, duplicate save and retry.
3. Write UI regressions for suggested and typed answers, the ordinary composer/transcript, Skill source staging, review/revision/save, Settings return and authoritative MCP status, scope changes and project overview entry. Wire the distinct Electron new-project setup offer while preserving sharing callbacks.
4. Run focused Gateway/contracts/UI/Electron/Web tests and relevant type checks with low worker counts. Use Node24, pinned pnpm10.33.4 and a 3GiB Node heap cap for local tooling. Sequence heavyweight builds/tests.
5. Run the Trellis check agent for cross-layer behavior and regressions, fix findings, update executable spec guidance where a new contract was learned, commit and update draft PR #3572. Use Fast CI where available.
6. Build and register the exact PR bundle through preview-bundle, then attempt a new owner-only Private Preview using the existing CLI. Preserve other previews. A quota denial must be reported without destroying unrelated machines.
7. Validate full create/import/skip/resume/review/save/use and isolation flows on Electron Desktop, Web Desktop and Web Canvas. Capture PR SHA, installed bundle, actual file-read/runtime evidence, screenshots and before/during/after Electron process memory. Use one bounded packaged test client.
8. Deliver a separate documentation draft PR in FinnaAI/matrix-os-site, covering setup and truthful runtime/MCP scope. Verify its matching documentation Preview if available.

## Rollback and pending evidence

Draft schema changes are additive and preserve old Chat reads. A rollback can leave scoped draft rows, which newer code can resume, while existing owner files stay intact. Saved guidance remains useful when a companion fails. No setup action changes connection permissions or runtime launch policy.

The current Figma Desktop tab still contains the guided onboarding section. Its document reports offline and native screenshot export is unavailable. The retained November12 approved screens and current shared Chat renderer are the visual baseline. Record any inability to refresh the design or finish live acceptance independently of local test success.
