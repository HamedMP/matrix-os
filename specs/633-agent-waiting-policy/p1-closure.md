# ENG-344 known P1 closure

Source baseline fd5cb38225f02f184e4cc64a79f52db3180adf37. Complete the known defects before requesting human review; follow the existing T3 busy/idle design and resource/auth/funding limits.

1. **Saved answer recovery**: reproduce resolve commit followed by continuation admission failure. Use existing owner Postgres and stable request identity; retain discoverable, explicit saved/pending state across refresh and support owner-authorized recovery. Never replay an uncertain model/tool, grant, approval or saved mutation. Recheck owner/chat/task/source and reject expired/cancelled state; duplicate recovery admits at most one turn. Existing normal Answer remains automatic next turn, never Steer. Tests cover refresh, duplicate ACK/recovery, cancellation/expiry/source change and foreign owner. UI parity through shared Bot surfaces and Native Mobile where implemented.
2. **Staging initialization**: run the actual provisioning directory step against a controlled filesystem with a protected parent, prove the missing-directory failure, then pre-create staging matrix:matrix0750 before the service runs. Existing parent protections and owner data remain intact. Keep separate from broader root-updater refactors.
3. **Attachment count feedback**: preserve eight-file capacity and 10/20MiB policy; retain accepted files and display explicit count rejection for overflow in each affected composer. RED for silent ninth file then GREEN controller/UI, no uploads for rejected files.
4. **Context and terminal delay**: trace main inference, tool boundaries, compaction and save independently with content-free diagnostics/controlled providers. A real slow phase is required before assigning the historical delay cause. Maintain context at safe completed-tool boundaries with the existing budget and cancellation signal; no incomplete tool pairs, no extra unrestricted model requests. Test context pressure and control interruption with actual loop.

Verification: focused functional suites for each changed boundary, configured typechecks, package exact head and matching existing Preview/Electron for affected workflows. Old 3ead long-run captures stay historical. No merge or production rollout. Current formal CI/Greptile follows the existing human gate. Record known environment failures, distinct test coverage gaps and any actual permission block.

Documentation: update current limitation/result report and public documentation draft; separate private site-repository documentation PR remains a release deliverable.

## Recovery contract and authority

| Route | Auth | Boundary / behaviour |
| --- | --- | --- |
| GET `/api/chats/:chatId/interactions?includeRecovery=true` | Existing authenticated personal-chat owner | Validate chat ID and boolean query; at most32 pending/recoverable projections. Only designated responder sees payload. No saved answer text in projection. Default remains legacy pending-only. |
| POST `/api/chats/:chatId/interactions/:interactionId/resolve?includeRecovery=true` | Existing authenticated personal-chat owner and designated responder | Existing64KiB body limit and bounded discriminated schema. `resume` carries only revision. Fresh reads require original resolved/unexpired blocking question, live direct binding and original waiting task. Only saved answer and deterministic request key are admitted. |

Saved resolution is the source of truth for recovery intent; canonical admitted/queued request identity and exact request hash are the source of truth for delivery acknowledgement. A lost ACK triggers only readback, never a second write in the error branch. Cancelled/expired or already-admitted requests are never offered as fresh work. Dispatch validates the exact original task and saved text inside its owner transaction; task revision CAS decides cancellation races. Normal runtime setup continues to validate current model source, funds and capabilities. No approval, grant or integration effect is replayed.

No new database, endpoint, background retry, persistent credential, permission, funding allowance, Relay deployment or queue policy is added. Review exposed a repeated-question ambiguity: owner migration9 adds nullable source_run_id to preserve the original asking Run from question creation. Existing rows remain untouched/null; pending legacy questions can bind to the current settled waiting Run under its row lock. Resolved legacy answers without provable source are not replayed. Recovery and dispatch both require the original source Run; a later question on the same task cannot reuse an old answer. The existing schema-version guard refuses old binaries after upgrade, so rollback requires a schema9-aware compatibility build; do not drop the column, erase owner answers or rewrite the migration ledger to roll back. New response projection fields require explicit client opt-in; existing strict readers retain their old shape. Shared Bot UI and Native Mobile use one recovery derivation. Local saved confirmation persists until refreshed server state; refresh discovers eligible recovery from owner Postgres.

## Context policy

The pinned Pi SDK1.0.0 `prepareRequest` hook runs before each ordinary inference, after complete tool results and queued corrections. Maintenance acts there, not in terminal save. Existing two-summary/total-inference caps and abort signal remain. Summary input/output are bounded, and an ordinary inference is reserved. Inference fitting preserves person text and complete tool pairs; existing tool-payload/assistant-context truncation is confined to private model context. Current images remain actual model inputs; text pressure excludes their encoded base64 and reserves SDK-estimated image tokens. If preserved person input cannot fit, stop before inference instead of silently truncating it. There is no claim that model-specific context metadata or the historical finalization latency has been live verified by these tests.

## Current offline evidence

- Owner state:80passed,1existing skipped; core/new boundaries99passed; neighbouring event/Steer/output cases38passed. Files overlap with earlier incremental receipts; totals are not independent coverage percentages.
- Native Mobile:59targeted Jest tests passed after isolating an unused Sheet native bridge in the card-test file only. Broader pre-existing Mobile type/environment failures remain outside this qualification.
- Configured eight TypeScript projects passed. They do not constitute Native Mobile or all-repository qualification.
- Provisioning filesystem/bootstrap48passed earlier; preserves existing cloud-init headroom and parent modes. No fresh VM was provisioned for this fix.
- New-head Electron/Preview qualification and human review remain required. Old screenshots, long-run evidence and CI/Greptile belong to their original SHAs.


Review correction: the single independent review found two Important defects, both reproduced RED: old saved question resurfacing during a later wait, and image-bearing active prompt lost after Steer under pressure. The correction binds question creation/recovery/dispatch to the asking Run, preserves early Answer before run settlement, and protects the active prompt plus all consumed corrections from historical compaction. Excluded generalized approval/effect replay, broader updater redesign, further attachment increases and unmeasured historical latency causes remain outside the approved fix. Migration8→9/restart/data preservation and refusal of schema8 binaries are explicit qualification cases.
