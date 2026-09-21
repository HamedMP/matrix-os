# S02 receipt — freeze shared wire contracts (T010–T014)

**Packet:** S02. **Tasks:** T010, T011, T012, T013, T014. **Date:** 2026-09-20.
**Base:** `124/s20-audience` tip `45e970090` (S20 stack #1789 → #1790 → #1791 on the S01 stack, main `fb8b21346`).
**Branch:** `124/s02`. Contracts only; no runtime behavior, migration or route wiring changed.

## Files

| Path | Lines | Purpose |
| --- | --- | --- |
| `packages/contracts/src/collaboration-capabilities.ts` | 282 | Presets, actions, audiences, resource kinds, grants, activations, effective access, readiness, generic errors |
| `packages/contracts/src/collaboration-direct.ts` | 383 | Protocol version, limits, tickets, sessions, request signatures, handshake, runtime registration, directory entries, control assertions/denials/acks, exact V1 route table |
| `packages/contracts/src/collaboration-execution.ts` | 286 | Execution policy per project or standalone Chat, effective submit mode, run submit/queue/run/binding, run control rules, Git action union and operation audit |
| `packages/contracts/src/collaboration-peer.ts` | 70 | `@deferred` S11/S13 peer ticket, session and chunk manifest |
| `packages/contracts/src/organization-billing.ts` | 54 | `@deferred` S14 payer ref, run payer binding, invite quote, member computer assignment |
| `packages/contracts/package.json`, `packages/contracts/src/index.ts` | — | Import map and exports (T014) |
| `tests/contracts/collaboration-capabilities.test.ts`, `collaboration-direct.test.ts`, `collaboration-execution.test.ts` | 199 / 236 / 232 | T010 |
| `specs/124-organization-collaboration/contracts/organization-api.md` | +25 | "Frozen payload unions (S02)" and version negotiation (T014) |

## RED → GREEN

| Command | RED (`c2e42789f`) | GREEN (`07c129efb`) |
| --- | --- | --- |
| `pnpm exec vitest run tests/contracts/collaboration-capabilities.test.ts tests/contracts/collaboration-direct.test.ts tests/contracts/collaboration-execution.test.ts` | 30 failed / 0 passed (every schema undefined) | 30 passed; 31 after the Greptile round (branch-corpus parity test) |
| `pnpm exec vitest run tests/contracts` | — | 38 files, 353 tests passed |
| `pnpm --filter @matrix-os/contracts exec tsc --noEmit` | — | clean |
| `bun run check:patterns` | — | 0 violations (5 pre-existing warnings) |
| `bun run typecheck` | — | initially failed in `desktop` on two missing S20 `organizationId` props; the 2026-09-21 rerun on local combined S02 head `79a8b846c` passed across all packages after the S20 fix and correct local workspace links |

## Schema inventory (frozen vocabulary)

- Presets: `viewer`, `contributor`. Viewer = chat.read, discussion.read, files.read, app.view, terminal.observe. Contributor adds discussion.post, ai.submit, ai.cancel_own, files.write, app.mutate, git.commit, git.push, git.pr, terminal.control.
- Audience: `{ kind: "organization" }` or `{ kind: "member", actorId }`. Grant state: pending, active, revoked, expired. Activation state: active, declined (absence is pending).
- Resource kinds: project, chat, terminal, app_instance, file, folder. Readiness items (project and chat only): ai_source, submit_mode, git_identity, chat_root_inventory.
- Submit mode: follow_organization, owner_only; effective: members, owner_only; organization metadata: members, owner_only, absent, unknown (absent/unknown resolve to owner_only).
- Run status: queued, claimed, running, waiting_for_approval, completed, failed, cancelled, interrupted (reasons: gateway_restart, scope_runtime_crash, run_unit_exit, control_partition). Control: cancel and tool_approval for requester or scope_owner; retry for requester.
- Git actions: status, diff, commit, push, pr; operation states: pending, running, completed, failed, unknown, reconciling. Branch names: `isCollaborationGitBranchName` mirrors the gateway's `isValidGitBranchName` (git-check-ref-format tightened for argv safety, plus no `refs/` prefix) and a contract test pins both validators to one corpus.
- Run decisions: `decidedBy.relation = requester` requires `actorId = requestingActorId`; `scope_owner` requires `actorId = scopeOwnerId` when present and never the requester unless the owner requested the run. Tool-approval bodies carry `runId` (identity in `:approvalId`), matching the existing handler and CLI.
- Readiness: a `ready` project or Chat must carry `sourceKind` and `effectiveSubmitMode`; file, folder, app instance and terminal never do.
- Ticket purposes: direct_session, events, terminal, control, peer. Protocol version 2; mismatch → `upgrade_required`.

## 2026-09-21 validation addendum

On local combined tree `79a8b846c` (divergent from the remote Graphite auto-rebase), `pnpm exec vitest run tests/contracts/collaboration-capabilities.test.ts tests/contracts/collaboration-direct.test.ts tests/contracts/collaboration-execution.test.ts --maxWorkers=2` passed **31/31**. `pnpm exec vitest run tests/contracts --maxWorkers=2` passed **38 files, 358/358 tests**. `bun run typecheck` passed, including Electron Desktop. `bun run check:patterns` found **0 violations and 5 existing warnings**. The earlier desktop failure above was historical; the S20 component props are now present on this combined tree. These checks do not establish a current remote-head CI or Greptile result after Graphite restacking.

| Surface | S02 contract effect | Direct S02 surface evidence |
| --- | --- | --- |
| Web Canvas | Shared schema only; no S02 UI/runtime behavior | N/A |
| Web Desktop | Shared schema only; no S02 UI/runtime behavior | N/A |
| Electron Desktop | Shared schema only; no S02 UI/runtime behavior | N/A; full typecheck passed |
| Web Mobile | Shared schema only; no S02 UI/runtime behavior | N/A |
| Native Mobile | Shared schema only; no S02 UI/runtime behavior | N/A |

## Open gates

- This local validation must be repeated or superseded on the Graphite-restacked remote head; current-head CI and Greptile remain release gates.
- S03 must register the membership projection before any `membership_assertion` is positive; S04 consumes `CollaborationGrantActivationSchema` and `CollaborationEffectiveAccessSchema`; S05 consumes the ticket, session and control schemas; S08/S09 consume the execution policy, run and Git schemas; S12 consumes `CollaborationResourceKindSchema` for standalone shares.
