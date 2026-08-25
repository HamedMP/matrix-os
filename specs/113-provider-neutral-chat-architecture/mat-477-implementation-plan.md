# MAT-477 implementation plan

MAT-477 adds the canonical Turn/Run execution seam on top of the PostgreSQL
Chat repository. It remains stacked on MAT-347 so every Provider call uses the
same owner-authorized execution-root provenance.

## Vertical slices

1. Add strict Turn admission, same-Turn retry, and Run-cancel contracts. The
   verified request principal remains the owner source of truth; clients never
   submit owners, paths, credentials, or Provider-native resume state.
2. Admit the user message, Turn, first Run attempt, Provider binding, adapter
   envelope, and outbox event in one repository transaction. Provider work
   begins only after that transaction commits.
3. Execute through a bounded canonical adapter registry. Revalidate the
   MAT-347 root fingerprint immediately before invoking a Provider, normalize
   every event before persistence, and commit the assistant message together
   with the terminal Run/Turn transition.
4. Add cancellation, same-Instance resume state, late-event rejection, and
   restart reconciliation. Keep active controllers capped and drain them on
   Gateway shutdown.
5. Wire the existing Matrix kernel (`hermes` system-agent Driver), Codex, and
   Claude Code through this one contract, then validate HTTP replay and real
   runtime behavior before Human Review.

## Security and resource limits

| Route | Auth | Boundary |
|---|---|---|
| `POST /api/chats/:chatId/turns` | existing verified Gateway principal | strict Zod body, 128 KiB body limit, owner-derived scope |
| `POST /api/chats/:chatId/turns/:turnId/runs` | existing verified Gateway principal | strict Zod body, 4 KiB body limit, same bound Instance and immutable Turn input |
| `POST /api/chats/:chatId/runs/:runId/cancel` | existing verified Gateway principal | strict Zod body, 4 KiB body limit, owner/run match |

Provider calls have bounded abort signals and run outside database locks.
Adapter state is capped at 64 KiB, normalized activities remain capped by the
repository, raw Provider errors are logged only by name, and clients receive a
canonical safe error. Provider event queues are capped at 500 events, the
active-Run registry is capped at 8 per owner and 64 globally, and Gateway gives
Provider cancellation a 10-second total shutdown drain budget.

## Explicit exclusions

- Legacy JSON cutover/import and renderer-store deletion remain outside this
  issue.
- Desktop composition, message polish, and inspector UI remain MAT-476/MAT-480
  integration work.
- OpenCode/OpenClaw do not receive a special execution path. Pi is added only
  after it satisfies the same canonical adapter contract.
- Provider-native state never becomes a Chat ID or crosses a Driver/Instance
  boundary.
- Codex and Claude Code temporarily reuse the existing Gateway coding-thread
  execution seam as adapter-internal state. Canonical PostgreSQL Chat records
  remain authoritative; MAT-479 owns deletion of the legacy projection after
  parity and migration evidence.

## Documentation deliverable

After runtime behavior is accepted, publish a separate public documentation PR
in `FinnaAI/matrix-os-site`; do not create a local `www/` replacement.
