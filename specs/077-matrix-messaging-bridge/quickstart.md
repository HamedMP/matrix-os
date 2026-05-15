# Quickstart: Matrix Messaging Bridge Planning Validation

This quickstart validates the plan before implementation tasks are generated. It is not a production rollout guide.

## 1. Confirm Spec Inputs

```bash
git status --short
.specify/scripts/bash/setup-plan.sh --json
```

Expected:

- Current branch is `077-matrix-messaging-bridge`.
- Plan path is `specs/077-matrix-messaging-bridge/plan.md`.
- Spec path is `specs/077-matrix-messaging-bridge/spec.md`.

## 2. Run Homeserver/Bridge Spike

Create a throwaway owner VPS or local equivalent with owner-local Postgres and candidate homeserver services. For each homeserver candidate still under consideration, run Telegram and WhatsApp bridge checks.

Required checks:

```text
1. Register bridge as application service.
2. Confirm bridge namespace/ghost users are created.
3. Complete Telegram login.
4. Complete WhatsApp pairing.
5. Receive inbound text from original app.
6. Send outbound text from Matrix.
7. Send or receive one bounded media item.
8. Verify encrypted-room posture: either first-slice rooms are unencrypted with explicit documentation, or E2EE key sharing/decryption is proven to respect Matrix OS room permissions.
9. Restart homeserver and bridge services.
10. Verify connected account, rooms, and latest messages recover.
11. Restore from backup snapshot and verify sessions/mappings survive.
12. Revoke Hermes read permission and verify no new content reaches Hermes.
13. Revoke while Hermes is streaming and verify queued work is cancelled, running work receives an abort signal, and unsent replies become `cancelled` or `approval_required`.
```

Exit criteria:

- If Conduit passes every Telegram and WhatsApp row, it can remain a candidate.
- If Synapse passes and Conduit does not, planning should select Synapse or document a split-homeserver transition.
- If WhatsApp cannot preserve session state through restart and restore, implementation tasks must stay blocked.
- If Synapse is selected, choose split-homeserver or complete a Conduit-to-Synapse migration spike before tasks.

## 3. Write Failing Contract Tests First

Before runtime implementation, add failing tests for:

```bash
bun run test tests/gateway/messages/routes.test.ts
bun run test tests/gateway/messages/permission-registry.test.ts
bun run test tests/gateway/messages/appservice-events.test.ts
```

Minimum red tests:

- Unknown network slug is rejected.
- Mutating endpoints enforce body limits.
- Expired setup sessions cannot complete.
- Permission updates require matching base revision.
- New rooms default to no Hermes read, reply, or automation access.
- Revoked rooms stop Hermes and automation delivery.
- Reply without permission becomes approval/draft instead of sending.
- Appservice token comparison uses the constant-time helper.
- Hermes internal reply capability token is owner/room/action scoped, expires after 60 seconds, and is unavailable to model prompts/subagents.
- Revocation aborts queued/running Hermes work and rechecks permission before send.
- In-flight reply send uses a stable `clientTxnId` and does not duplicate if cancellation races with timeout/retry.
- Draft routes list, approve, and cancel pending replies with owner scoping.
- Appservice event idempotency uses Matrix homeserver `event_id`.
- Client-visible errors do not leak raw provider/internal details.

## 4. Validate Owner Storage Map

Confirm the implementation plan names each store:

| Data | Required owner-controlled location |
|------|------------------------------------|
| Homeserver state | customer VPS homeserver DB |
| Telegram bridge state | separate Telegram bridge DB/schema |
| WhatsApp bridge state | separate WhatsApp bridge DB/schema |
| Permissions | Matrix OS owner-local Postgres tables |
| Audit events | Matrix OS owner-local Postgres tables |
| Setup sessions | Matrix OS owner-local Postgres tables with TTL cleanup |
| Conversation mappings | Matrix OS owner-local Postgres tables |
| Media/cache metadata | owner-local store with backup/delete policy |

Initial caps:

| Resource | Cap |
|----------|-----|
| Queued events per owner | 10,000 |
| Queued events per network | 2,000 |
| Queued events per room | 500 |
| Concurrent media jobs per owner | 100 |
| Concurrent media jobs per room | 10 |
| Idempotency key retention | 30 days |
| Setup session TTL | 10 minutes |
| Setup cleanup sweep | 15 minutes |

Customer VPS floor:

| Mode | Minimum |
|------|---------|
| Telegram + WhatsApp without Synapse selection | 2 vCPU, 4 GiB RAM, 40 GiB disk |
| Synapse-backed Telegram + WhatsApp | 2 vCPU, 6 GiB RAM, 60 GiB disk |
| Below floor | messaging disabled, Telegram-only experimental, or upgrade prompt |

Recovery boundary:

| Boundary | Value |
|----------|-------|
| Messaging backup RPO | 1 hour |
| Messaging restore RTO | 15 minutes after VPS is reachable |
| WhatsApp stale restore relink threshold | Snapshot older than 24 hours or paired-device session rejected |

## 5. Select Hermes Participation Mode

Choose one before tasks:

```text
preferred: Hermes as gated event consumer
fallback: Hermes as gated observer
risky: Hermes as direct Matrix room member
```

The selected mode must explain:

- Whether Hermes can see room history.
- Whether Hermes appears as a room member.
- How revocation cancels queued work.
- How replies are sent after permission is checked.
- How mention-only mode is enforced.
- How E2EE keys or decrypted payloads are withheld when permission is absent or revoked.

## 6. Confirm Deferred Scope

First implementation defers:

- Bidirectional edits.
- Deletes.
- Reactions.
- Read receipts.
- Typing indicators.
- Stickers and voice notes beyond safe media preview/download.
- Full historical import beyond capped latest-message backfill.
- Org-shared messaging accounts.

## 7. Confirm Duplicate Adapter Reconciliation

For a connected Telegram or WhatsApp account:

```text
bridged Matrix room -> authoritative path for Hermes and automations
legacy direct adapter -> disabled for AI delivery or notification-only
```

The gateway must detect same owner/network/account identity before allowing both paths to deliver content to Hermes.

## 8. Manual User Flow Check

Expected first product flow:

```text
1. User opens Messages.
2. User connects Telegram.
3. Telegram conversations appear with Hermes access off.
4. User grants read access to one Telegram room.
5. Hermes sees only that room.
6. User connects WhatsApp.
7. WhatsApp conversations appear with Hermes access off.
8. User grants reply access to one WhatsApp room.
9. Hermes reply sends only after final permission check.
10. User revokes access.
11. New messages no longer reach Hermes or automations within 10 seconds.
```

## 9. Required Pre-PR Gates For Implementation

When this moves beyond planning:

```bash
bun run typecheck
bun run check:patterns
bun run test
```

Add focused suites for the new module before running the full suite. Backend PRs must include an Invariants section covering source of truth, transaction scope, acceptable orphan states, auth source of truth, and deferred scope.
