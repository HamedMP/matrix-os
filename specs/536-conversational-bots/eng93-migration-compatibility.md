# ENG-93 deployed-schema compatibility

Tracking: [ENG-93](https://linear.app/matrix-os/issue/ENG-93/enable-and-validate-recurring-tasks-on-the-launch-agent).

## Scope and source

Resume the existing personal Pi routine candidate, not another task or runtime framework. Official Main checked2026-10-24 at be6cce1404bfd6db3392c535bca2e0def32ec577 still ends at Bot v8. PR2759 remains unmerged; its changes are not imported or cherry-picked. No successor ENG-93/original-branch/routine/recurring PR was found.

The five real-PG failures come from the local unpublished candidate claiming v9/bot_routines, while deployed history records v9/bot_chat_threads. Restore the five exact statements from historical commit736d251d7bd097db1e7fb2822309767ffb1a9332, independently verified against frozen SQL. Register routines as v10; its DDL is unchanged. Preserve the v1–v8 registry, strict identity checks, advisory transaction lock, and every existing migration row/name/applied_at.

The original candidate and prior evidence show no publication/deployment. A database actually recording the erroneous local v9/bot_routines identity stays rejected. Do not relabel it, drop tables, invent alternate version identities, or silently migrate it. Unknown future versions and wrong v9/v10 names fail before pending DDL.

## Behavior and wiring

- Frozen v9: skip its DDL, preserve all retained rows, append v10 routine tables once.
- v8 and earlier: apply exact deployed v9 first, then v10. Existing direct/group bindings gain a nullable project_id; all previous field values remain unchanged.
- Concurrent/repeated gateway bootstrap uses the existing schema lock; each version applies once. A failed version rolls back its own DDL/record.
- Retained thread Turn/Retry/provider/queue execution stays unavailable. The new compatibility registration does not create or run threads, change authorizations/grants, or alter personal routine effect policy.
- Startup still bootstraps owner Chat/Bot PostgreSQL before repositories/scheduler registration. Ordinary Chat and routine tests must pass against the complete registry.

| Internal operation | Trust source | Failure behavior |
|---|---|---|
| Owner schema bootstrap | injected owner PostgreSQL handle | existing typed schema error; no new remote endpoint |
| Migration identity validation | owner bot_schema_migrations plus reviewed registry | wrong/future identities fail closed before pending DDL |
| Thread execution entry | existing authenticated owner, current bindings and canonical admission | existing unavailable guard before provider/new-run persistence |
| Routine scheduling | existing explicit background authorization plus owner-scoped durable claims | existing fail-closed effects/retry/dedup policy unchanged |

All DDL names are fixed OS-owned constants. No new network call, input path, credentials, permission grant, resource cache or process is introduced. Existing database resources retain their existing owner/shutdown policy. Production files stay focused and below500 lines; no broad extraction is needed for these edits.

## Test-driven plan

1. Preserve original worktree/untracked SHA, all three previous PG evidence rounds, exact remote/local heads and ticket identity.
2. Observe new registry/SQL contract RED and reproduce the original five real-PG failures before implementation.
3. Apply the minimal registry repair. Keep independent historical fixtures independent from production functions.
4. Run affected migration, compatibility, routine authorization/persistence/scheduler/routes and canonical guard unit tests; strict types and scoped canonical patterns.
5. Real PG16 pooled replay: original44, existing guard4, and new genuine-v9/v8/identity-collision checks. Verify exact statement order, historical values/timestamps, twelve contenders, future rejection and ordinary Chat/routine controls.
6. Independent review and local progress commit. Preserve all raw logs, source hashes, container limits and stop/no-OOM evidence.
7. Before release, update public developer/support docs in a separate FinnaAI/matrix-os-site PR; recommend engineering/integration-owner review of deployed schema history and the release rollback plan.

## Release and rollback gates

Applying this build changes the owner schema to v10. An older Main ending at v8 cannot reopen it; rollback requires an exact compatible reviewed build. Never downgrade or rewrite owner migration records. Local synthetic PG proof is not a deployment, real model, actual customer-account or device qualification.

No push, full CI, Greptile, merge/auto-merge, production deployment, Main restart/upgrade, credentials/permission mutation, real jobs/model/mail or Slack action is authorized by this local continuation. Shared desktop and any Matrix profile require a parent-scheduled slot; do not use QA63022 or other tasks' profiles. Live/client evidence remains open. Prepare the concrete acceptance request after the local candidate and evidence are reviewable.
