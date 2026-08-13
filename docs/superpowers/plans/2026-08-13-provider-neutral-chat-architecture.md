# Provider-Neutral Chat Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the JSON/provider-typed Chat rails with one owner-scoped,
PostgreSQL-backed Chat model, pluggable harness/model adapters, and canonical
Gateway projections used by every shell.

**Architecture:** The Gateway owns strict Chat contracts and a typed repository
in the existing customer-VPS Kysely connection. A transactional outbox keeps
shells convergent; harness adapters keep provider state opaque; file-backed
ProjectConfig remains authoritative through immutable project IDs. Delivery is
split into three independently reviewed PRs: persistence/cutover, adapters, and
shell migration.

**Tech Stack:** Node.js 24+, TypeScript 5.5+ strict ESM, Hono, Zod 4 via
`zod/v4`, PostgreSQL, Kysely, React 19, Zustand, Vitest, Playwright/Electron,
Flox, pnpm 10, bun.

## Global Constraints

- Read `AGENTS.md` and `.specify/memory/constitution.md` at the start of every
  implementation session and after compaction.
- TDD is mandatory: every runtime task follows Red -> Green -> Refactor and
  records the failing and passing command output.
- Owner-local PostgreSQL through the existing Gateway-owned Kysely instance is
  the only durable Chat authority after cutover. Never create or close a second
  pool from a Chat repository.
- Platform PostgreSQL never stores owner Chat content.
- Chat ID is independent of harness, model, provider session, shell, project
  slug, and filesystem path.
- Provider state is accessible only through the matching harness adapter ID and
  state schema version. Cross-harness resume is forbidden.
- Project context stores immutable `ProjectConfig.id` only. Project paths,
  slugs, branches, remotes, owner scope, and runtime identity are not accepted
  from clients or persisted as Chat identity.
- Run admission, project-context mutation, archive/delete, and active-run checks
  lock the same Chat row in one transaction. External calls stay outside locks.
- Every mutating endpoint uses Hono `bodyLimit`, including DELETE.
- Cross-shell events are inserted transactionally and published after commit.
- No indefinite dual write: JSON is authoritative before the cutover marker;
  PostgreSQL is the sole read/write authority after it.
- Preserve MAT-299/PR #1213 and MAT-318 as separate work. Do not add behavior to
  their current PRs.
- Do not modify, depend on, or create a Linear relation to MAT-268.
- Figma direct parity remains unverified until the Matrix OS View-seat MCP limit
  is restored. Do not retry the blocked MCP during these slices.
- Public user documentation is a separate PR in `FinnaAI/matrix-os-site`; do
  not create a local `www/` tree.

---

## Follow-up slice map

| Slice | Deliverable | Dependency | Suggested conventional PR title |
|---|---|---|---|
| A | Typed owner-Postgres repository, immutable project-ID resolver, Gateway API/outbox, idempotent JSON cutover, export/delete/shutdown | Architecture spec approved | `feat(chat): add owner-owned canonical persistence` |
| B | Harness/model registries, adapter-only provider state, Hermes/OpenClaw/Codex/Pi/OpenCode adapters, resume/switch/fork orchestration | Slice A merged | `feat(chat): add provider-neutral harness adapters` |
| C | Browser/Desktop/CLI/channel projections on `/api/chats`, event replay, renderer rail removal, cutover evidence | Slices A and B merged | `feat(chat): migrate shells to canonical chats` |

Create a separate Linear child/follow-up issue for each slice under MAT-319.
Relations may connect only these Chat slices and the existing MAT-299/MAT-318
sequencing; no MAT-268 relation is permitted. Keep every issue `In Progress`
until its PR exists, then `PR In Review`, and never `Done` before merge.

## File structure

### Slice A — persistence and cutover

- `packages/contracts/src/chat.ts`: strict provider-neutral Chat, message, Turn,
  Run, project projection, request, response, event, and error schemas.
- `packages/contracts/src/index.ts`: exports only; do not add another large Chat
  implementation block to this already-large file.
- `packages/gateway/src/chat/database.ts`: typed Kysely table interfaces and
  migration/bootstrap DDL.
- `packages/gateway/src/chat/repository.ts`: owner-scoped reads/mutations,
  transactions, optimistic revisions, and outbox insertion.
- `packages/gateway/src/chat/project-resolver.ts`: immutable-ID ProjectConfig
  resolution with safe public projection plus exact direct-project/registered-
  worktree execution-root references and fingerprints.
- `packages/gateway/src/chat/service.ts`: authorization-independent orchestration
  over repository/project resolver; no Hono or provider code.
- `packages/gateway/src/chat/routes.ts`: Hono validation, auth principal mapping,
  body limits, safe errors, and HTTP projections.
- `packages/gateway/src/chat/subscriptions.ts`: bounded, owner-authorized outbox
  replay/live delivery and shutdown drain.
- `packages/gateway/src/chat/migration.ts`: JSON enumeration, hashing, import,
  verification, advisory lock, maintenance barrier, and cutover marker.
- `packages/gateway/src/chat/export.ts`: streamed export and symlink-safe temp
  cleanup policy.
- `packages/gateway/src/project-manager.ts`: owner-scoped immutable-ID lookup;
  file config remains authoritative.
- `packages/gateway/src/server.ts`: dependency wiring and shutdown ordering only.
- Focused tests in `tests/contracts/chat.test.ts` and
  `tests/gateway/chat-*.test.ts`.

### Slice B — harness and model adapters

- `packages/gateway/src/chat/harness-contract.ts`: adapter-only internal types,
  normalized event validation, and state envelope limits.
- `packages/gateway/src/chat/harness-registry.ts`: bounded adapter catalog,
  duplicate detection, health/setup cache, and invalidation.
- `packages/gateway/src/chat/model-registry.ts`: model plugin catalog and
  capability resolution.
- `packages/gateway/src/chat/run-orchestrator.ts`: Run start/resume/cancel,
  canonical history windows, failure reconciliation, switching, and fork.
- `packages/gateway/src/chat/adapters/hermes.ts`: Kernel/Hermes adapter.
- `packages/gateway/src/chat/adapters/openclaw.ts`: OpenClaw adapter over the
  existing agent-config/runtime seam.
- `packages/gateway/src/chat/adapters/coding-agent.ts`: bridge for existing
  Codex/Pi/OpenCode coding-agent adapters without making provider ID Chat
  identity.
- `packages/gateway/src/server.ts`: registry/orchestrator wiring and drain.
- Focused tests in `tests/gateway/chat-harness-*.test.ts` and
  `tests/gateway/chat-run-orchestrator.test.ts`.

### Slice C — shell migration

- `shell/src/lib/chat-contract.ts`: shared validated API/event client helpers.
- `shell/src/stores/chat-context.tsx`: canonical Chat list/detail/replay state.
- `shell/src/hooks/useConversation.ts`: temporary compatibility wrapper removed
  after all callers use the canonical store.
- `desktop/src/renderer/src/stores/chats.ts`: runtime-scoped canonical Chat
  projection and safe mutations.
- `desktop/src/renderer/src/features/chat/ChatTab.tsx`: one Chat rail labeled by
  capabilities/project, not by source type.
- `desktop/src/renderer/src/stores/hermes-chat.ts`, `stores/threads.ts`, and
  `stores/unified-threads.ts`: delete renderer identity/history ownership after
  parity; keep only transient composer/stream projection where needed.
- `desktop/src/main/` Chat IPC/event bridge files: validated native access to
  the same Gateway contract, no main-process persistence.
- `packages/gateway/src/channels/` and CLI Chat commands: bind channel/CLI
  principals to the canonical API rather than direct JSON files.
- Shell/Desktop/Electron/CLI tests listed in Tasks 12-15.

## Slice A — owner persistence and cutover

### Task 1: Define strict Chat contracts

**Files:**
- Create: `packages/contracts/src/chat.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `tests/contracts/chat.test.ts`

**Interfaces:**
- Consumes: `SafeDisplayStringSchema`, `RequestIdSchema`, `ProjectIdSchema`,
  `IsoTimestampSchema`, and bounded helpers from `packages/contracts/src/index.ts`.
- Produces: `ChatIdSchema`, `ChatMessageIdSchema`, `ChatTurnIdSchema`,
  `ChatRunIdSchema`, `ChatSummarySchema`, `ChatDetailSchema`,
  `CreateChatRequestSchema`, `UpdateChatRequestSchema`,
  `CreateChatTurnRequestSchema`, `ForkChatRequestSchema`,
  `ChatHarnessDescriptorSchema`, `ChatModelDescriptorSchema`, and
  `ChatOutboxEventSchema`.

- [ ] **Step 1: Write failing contract tests**

```ts
expect(CreateChatRequestSchema.safeParse({
  clientRequestId: "req_chat_1",
  projectId: "proj_123",
  ownerId: "attacker",
}).success).toBe(false);

expect(CreateChatTurnRequestSchema.safeParse({
  clientRequestId: "req_turn_1",
  message: "Ship the owner-local repository",
  harnessId: "codex",
  modelId: "gpt-5",
  providerResumeState: { conversationId: "foreign" },
}).success).toBe(false);

expect(ChatIdSchema.parse("chat_123")).toBe("chat_123");
```

- [ ] **Step 2: Run the test and verify Red**

Run: `flox activate -- bun run test tests/contracts/chat.test.ts`
Expected: FAIL because `packages/contracts/src/chat.ts` and its exports do not
exist.

- [ ] **Step 3: Add strict discriminated schemas and limits**

```ts
export const ChatIdSchema = z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/);
export const ChatMessageStateSchema = z.enum(["pending", "committed", "failed"]);
export const ChatExecutionSelectionSchema = z.object({
  harnessId: ProviderIdSchema,
  modelId: ProviderIdSchema.optional(),
}).strict();
export const CreateChatRequestSchema = z.object({
  clientRequestId: RequestIdSchema,
  title: SafeDisplayStringSchema.optional(),
  projectId: ProjectIdSchema.optional(),
  defaultSelection: ChatExecutionSelectionSchema.optional(),
}).strict();
```

Define the message-parts discriminated union, 100-item Chat pages, 200-message
pages, 64 parts, 24,000-character/96-KiB input, safe errors, harness/model
descriptors, and outbox event shapes exactly as specified.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `flox activate -- bun run test tests/contracts/chat.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/chat.ts packages/contracts/src/index.ts tests/contracts/chat.test.ts
git commit -m "feat(contracts): define canonical chat model"
```

### Task 2: Resolve immutable ProjectConfig IDs

**Files:**
- Modify: `packages/gateway/src/project-manager.ts`
- Create: `packages/gateway/src/chat/project-resolver.ts`
- Modify: `tests/gateway/project-manager.test.ts`
- Create: `tests/gateway/chat-project-resolver.test.ts`

**Interfaces:**
- Consumes: `ProjectConfig`, `OwnerScope`, existing safe project reads, and
  WorktreeManager's validated records.
- Produces: `ProjectLookupResult`,
  `ProjectManager.getProjectById(input: { ownerScope: OwnerScope;
  projectId: string }): Promise<ProjectLookupResult>` and
  `ChatProjectResolver.resolve(ownerScope, projectId)` returning a safe
  `ChatProjectProjection`, plus `resolveExecutionRoot(ownerScope,
  { projectId, worktreeId? })` returning an internal exact root and fingerprint.

- [ ] **Step 1: Write failing immutable-ID tests**

```ts
const before = await projects.getProjectById({ ownerScope, projectId: created.id });
await renameProjectSlugOnDisk(created.slug, "renamed-project");
const after = await projects.getProjectById({ ownerScope, projectId: created.id });
expect(before.ok && after.ok && after.project.id).toBe(created.id);
expect(JSON.stringify((await resolver.resolve(ownerScope, created.id)).projection))
  .not.toContain(created.localPath);

expect(await resolver.resolveExecutionRoot(ownerScope, {
  projectId: githubProject.id,
  worktreeId: registeredSiblingWorktree.id,
})).toMatchObject({ ref: { kind: "worktree", projectId: githubProject.id } });
```

Cover duplicate IDs, archived/deleting configs, owner mismatch, unreadable
paths, cache eviction, and reconciliation after file changes. Add fixtures for
a managed repository root, an owner-approved external folder project's exact
`localPath`, a registered sibling worktree, an unregistered sibling with the
same prefix, mismatched project/worktree metadata, deleted/moved worktrees, and
symlink retargeting. Public projections must contain neither root path.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/project-manager.test.ts tests/gateway/chat-project-resolver.test.ts`
Expected: FAIL because immutable-ID lookup does not exist.

- [ ] **Step 3: Add a bounded reconciled ID index**

```ts
export type ProjectLookupResult =
  | { ok: true; project: ProjectConfig }
  | { ok: false; status: number; error: WorkspaceError };

export type ChatExecutionRootRef =
  | { kind: "project"; projectId: string }
  | { kind: "worktree"; projectId: string; worktreeId: string };

async getProjectById(input: { ownerScope: OwnerScope; projectId: string }) {
  const project = await immutableIdIndex.resolve(input.projectId);
  if (!project || !ownerScopeMatches(project.ownerScope, input.ownerScope)) {
    return genericError(404, "not_found", "Project was not found");
  }
  return { ok: true as const, project };
}
```

Build the index only from validated owner file configs, cap entries to the
existing project maximum, invalidate it on create/lifecycle/delete/file-watch
changes, and fail closed on duplicate immutable IDs. Do not store ProjectConfig
in PostgreSQL. Resolve direct roots by exact realpath equality with the current
`ProjectConfig.localPath`; resolve worktrees only from an exact WorktreeManager
record for that ProjectConfig's slug and canonical managed worktree metadata.
Never approve a path merely because it shares an ancestor or string prefix.
Fingerprint the canonical safe reference, owner scope, immutable project ID,
validated project realpath, and, for worktrees, the record ID/project slug/
validated realpath/creation timestamp. Persist only that fingerprint and safe
reference with the Run, then require an exact match on pre-dispatch re-resolution.

- [ ] **Step 4: Run tests and verify Green**

Run: `flox activate -- bun run test tests/gateway/project-manager.test.ts tests/gateway/chat-project-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/project-manager.ts packages/gateway/src/chat/project-resolver.ts tests/gateway/project-manager.test.ts tests/gateway/chat-project-resolver.test.ts
git commit -m "feat(projects): resolve immutable project identities"
```

### Task 3: Bootstrap the typed Chat schema and repository

**Files:**
- Create: `packages/gateway/src/chat/database.ts`
- Create: `packages/gateway/src/chat/repository.ts`
- Create: `tests/gateway/chat-repository.test.ts`
- Modify: `packages/gateway/src/server.ts`

**Interfaces:**
- Consumes: injected `Kysely<OwnerDatabase>` from `createAppDb`.
- Produces: `migrateChatTables(db)`, `ChatRepository`,
  `createChatRepository(db)`, and owner-scoped paginated read/create methods.

- [ ] **Step 1: Write failing repository tests with the existing Kysely test dialect**

```ts
const first = await repository.create(owner, request);
const retry = await repository.create(owner, request);
expect(retry.id).toBe(first.id);
await expect(repository.get(otherOwner, first.id)).resolves.toBeNull();
expect(await repository.list(owner, { limit: 100 })).toMatchObject({
  items: [expect.objectContaining({ id: first.id })],
});
```

Also assert schema migration idempotency, message pagination, full-text owner
isolation, partial unique active Run, and that `repository.close()` does not
destroy the injected Kysely instance.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/chat-repository.test.ts`
Expected: FAIL because the repository is absent.

- [ ] **Step 3: Implement typed tables and idempotent bootstrap**

```ts
export interface ChatRepository {
  create(owner: ChatOwner, request: CreateChatRequest): Promise<ChatRecord>;
  get(owner: ChatOwner, chatId: string): Promise<ChatRecord | null>;
  list(owner: ChatOwner, query: ChatListQuery): Promise<ChatPage>;
  pageMessages(owner: ChatOwner, chatId: string, query: MessagePageQuery): Promise<MessagePage>;
}

export function createChatRepository(db: Kysely<OwnerDatabase>): ChatRepository {
  return new KyselyChatRepository(db); // injected, non-owning dependency
}
```

Create all tables/indexes from the spec with `CREATE TABLE/INDEX IF NOT EXISTS`
or the repository's versioned migration pattern. Use `ON CONFLICT` for logical
singleton/idempotency keys and filter deleted content on normal reads.

- [ ] **Step 4: Run repository tests and typecheck**

Run: `flox activate -- bun run test tests/gateway/chat-repository.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chat/database.ts packages/gateway/src/chat/repository.ts packages/gateway/src/server.ts tests/gateway/chat-repository.test.ts
git commit -m "feat(chat): add owner-local repository"
```

### Task 4: Make admission, context, and deletion atomic

**Files:**
- Modify: `packages/gateway/src/chat/repository.ts`
- Create: `packages/gateway/src/chat/service.ts`
- Create: `tests/gateway/chat-concurrency.test.ts`

**Interfaces:**
- Consumes: Chat repository, project resolver, strict requests.
- Produces: `ChatService.admitTurn`, `updateChat`, `archiveChat`, `deleteChat`,
  and transactionally inserted outbox events.

- [ ] **Step 1: Write failing race and idempotency tests**

```ts
const admission = service.admitTurn(owner, chat.id, turnRequest);
const contextChange = service.updateChat(owner, chat.id, {
  baseRevision: chat.revision,
  projectId: otherProject.id,
});
const [turnResult, updateResult] = await Promise.allSettled([admission, contextChange]);
expect([turnResult, updateResult].filter((result) => result.status === "fulfilled"))
  .toHaveLength(1);

await expect(service.deleteChat(owner, chat.id, deleteRequest))
  .rejects.toMatchObject({ code: "chat_busy" });
```

Also cover two simultaneous Turns, late finalization after delete, stale
revision, repeated request IDs, transaction rollback, and outbox rollback.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/chat-concurrency.test.ts`
Expected: FAIL because mutation methods do not exist.

- [ ] **Step 3: Implement the shared row-lock boundary**

```ts
await db.transaction().execute(async (trx) => {
  const chat = await lockOwnedChat(trx, owner, chatId); // SELECT ... FOR UPDATE
  assertRevision(chat, request.baseRevision);
  await assertNoActiveRun(trx, chat.id);
  await insertTurnMessageRunAndOutbox(trx, chat, request);
  await bumpChatRevision(trx, chat.id, chat.revision);
});
```

Keep project resolution inputs fixed before the external call and re-check the
file-backed project under the admission flow before commit. Do not call a
harness inside the transaction. Hard delete content, create a content-free
tombstone, and append the deletion event atomically.

- [ ] **Step 4: Run concurrency and repository tests**

Run: `flox activate -- bun run test tests/gateway/chat-concurrency.test.ts tests/gateway/chat-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chat/repository.ts packages/gateway/src/chat/service.ts tests/gateway/chat-concurrency.test.ts
git commit -m "feat(chat): serialize canonical mutations"
```

### Task 5: Add authenticated routes and replayable subscriptions

**Files:**
- Create: `packages/gateway/src/chat/routes.ts`
- Create: `packages/gateway/src/chat/subscriptions.ts`
- Modify: `packages/gateway/src/server.ts`
- Create: `tests/gateway/chat-routes.test.ts`
- Create: `tests/gateway/chat-subscriptions.test.ts`
- Modify: `tests/gateway/auth.test.ts`

**Interfaces:**
- Consumes: ChatService, ChatRepository outbox reads, verified
  `RequestPrincipal`.
- Produces: `/api/chats` HTTP routes and authenticated Chat event WebSocket.

- [ ] **Step 1: Write failing route/auth/subscriber tests**

```ts
expect((await app.request(oversizedPost("/api/chats", 97 * 1024))).status).toBe(413);
expect((await app.request(authenticatedDelete(`/api/chats/${chat.id}`, { ownerId: "fake" }))).status).toBe(400);
expect((await otherOwnerApp.request(`/api/chats/${chat.id}`)).status).toBe(404);
expect(subscription.sent.at(-1)).toMatchObject({ type: "chat.updated", chatId: chat.id });
```

Cover every path/query schema, DELETE body limit, personal/org roles, browser
query-token allowlist, malformed/oversized WS frames, replay cursor/gap, stale
TTL eviction, failed-sender eviction, per-owner/global caps, and shutdown drain.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/chat-routes.test.ts tests/gateway/chat-subscriptions.test.ts tests/gateway/auth.test.ts`
Expected: FAIL because routes/subscriptions are absent.

- [ ] **Step 3: Implement safe routes and outbox delivery**

```ts
app.post("/api/chats/:chatId/turns", chatBodyLimit, async (c) => {
  const principal = requireRequestPrincipal(c);
  const chatId = ChatIdSchema.parse(c.req.param("chatId"));
  const body = CreateChatTurnRequestSchema.parse(await c.req.json());
  return c.json(await service.admitTurn(ownerFrom(principal), chatId, body), 202);
});
```

Map typed errors once to generic codes. Await subscription authorization before
success, isolate sends, remove dead senders after broadcast, and publish only
committed outbox rows.

- [ ] **Step 4: Run route/subscription/auth tests**

Run: `flox activate -- bun run test tests/gateway/chat-routes.test.ts tests/gateway/chat-subscriptions.test.ts tests/gateway/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chat/routes.ts packages/gateway/src/chat/subscriptions.ts packages/gateway/src/server.ts tests/gateway/chat-routes.test.ts tests/gateway/chat-subscriptions.test.ts tests/gateway/auth.test.ts
git commit -m "feat(chat): expose canonical gateway contracts"
```

### Task 6: Import JSON idempotently and cut over once

**Files:**
- Create: `packages/gateway/src/chat/migration.ts`
- Create: `tests/gateway/chat-migration.test.ts`
- Modify: `packages/gateway/src/server.ts`

**Interfaces:**
- Consumes: Conversation JSON, coding-agent `threads.json`, ChatRepository,
  migration advisory lock, Gateway admission barrier.
- Produces: `ChatMigrationCoordinator.inspect`, `importBatch`, `verify`,
  `cutover`, and `assertCompatibleStartup`.

- [ ] **Step 1: Write failing migration matrix tests**

```ts
await migration.importBatch();
await migration.importBatch();
expect(await counts()).toEqual({ chats: 2, turns: 3, duplicateImports: 0 });

await writeChangedLegacyRecord();
await migration.importBatch();
expect(await importedHash(sourceId)).toBe(expectedChangedHash);

await expect(migration.cutover()).rejects.toMatchObject({ code: "migration_verification_failed" });
expect(await migration.hasCutoverMarker()).toBe(false);
```

Cover symlinks, oversized/invalid JSON, duplicate IDs, crash after each phase,
valid/invalid resume state, preservation of Pi `cwd` for the exact current
project root, owner-approved external folder root, and registered sibling
worktree, quarantine of arbitrary/unregistered/ambiguous sibling paths,
transcript ordering, active Run drain, final delta, marker atomicity,
old-release startup refusal, and legacy-ID translation before, exactly at, and
after the immutable 90-day expiry.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/chat-migration.test.ts`
Expected: FAIL because the coordinator is absent.

- [ ] **Step 3: Implement phased importer and explicit marker**

```ts
export type ChatMigrationPhase =
  | "not_started" | "importing" | "verified" | "cutting_over" | "complete" | "failed";

await db.transaction().execute(async (trx) => {
  await verifyFinalFingerprint(trx, fingerprint);
  const cutoverAt = clock.now();
  await setCutoverMarker(trx, {
    version: CHAT_SCHEMA_VERSION,
    fingerprint,
    cutoverAt,
    legacyAliasExpiresAt: addDays(cutoverAt, 90),
  });
  await appendMigrationOutbox(trx);
});
```

Use normalized hashes and unique source mappings with `ON CONFLICT`. Keep JSON
untouched and read-only after marker. Never add a JSON/Postgres dual writer or a
post-marker filesystem read fallback.

- [ ] **Step 4: Run migration/repository/concurrency tests**

Run: `flox activate -- bun run test tests/gateway/chat-migration.test.ts tests/gateway/chat-repository.test.ts tests/gateway/chat-concurrency.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chat/migration.ts packages/gateway/src/server.ts tests/gateway/chat-migration.test.ts
git commit -m "feat(chat): add idempotent postgres cutover"
```

### Task 7: Add export, delete cleanup, and shutdown evidence

**Files:**
- Create: `packages/gateway/src/chat/export.ts`
- Modify: `packages/gateway/src/chat/routes.ts`
- Modify: `packages/gateway/src/server.ts`
- Create: `tests/gateway/chat-export.test.ts`
- Create: `tests/gateway/chat-shutdown.test.ts`

**Interfaces:**
- Consumes: repository snapshot/export reads, attachment reference service,
  subscription hub, migration coordinator.
- Produces: bounded export jobs, symlink-safe recurring cleanup, and ordered
  Chat shutdown.

- [ ] **Step 1: Write failing export/delete/shutdown tests**

```ts
expect(exported).toMatchObject({ chat: { id: chat.id }, turns: expect.any(Array) });
expect(JSON.stringify(exported)).not.toMatch(/providerResumeState|access[_-]?token/i);
await gateway.close();
expect(order).toEqual([
  "admission.stop", "runs.drain", "runs.interrupt", "subscribers.drain",
  "exports.stop", "shared-kysely.destroy",
]);
```

Cover 20-export cap, 24-hour TTL, recurring timer cleanup, `lstat` symlink skip,
shared attachment preservation, exclusive attachment deletion, repeated delete,
10-second Run drain, restart reconciliation, and no double Kysely destroy.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/chat-export.test.ts tests/gateway/chat-shutdown.test.ts`
Expected: FAIL because export and shutdown wiring are incomplete.

- [ ] **Step 3: Implement streamed export and ordered cleanup**

```ts
const cleanupPolicy = { maxFilesPerOwner: 20, ttlMs: 24 * 60 * 60 * 1000 };
await chatAdmissions.stop();
await runOrchestrator.drain({ timeoutMs: 10_000 });
await chatSubscriptions.shutdown();
chatExportCleanup.stop();
// appDb.destroy() remains the only shared Kysely owner close.
```

- [ ] **Step 4: Run Slice A validation**

Run:
`flox activate -- bun run test tests/contracts/chat.test.ts tests/gateway/chat-*.test.ts tests/gateway/project-manager.test.ts tests/gateway/auth.test.ts`
Then: `flox activate -- bun run typecheck && bun run check:patterns:diff`
Expected: all focused tests pass, typecheck passes, and the diff adds no pattern
violations.

- [ ] **Step 5: Commit and open the Slice A PR**

```bash
git add packages/gateway/src/chat packages/gateway/src/server.ts packages/gateway/src/project-manager.ts tests/gateway tests/contracts
git commit -m "feat(chat): complete owner-owned persistence"
git push -u origin HEAD
gh pr create --title "feat(chat): add owner-owned canonical persistence" --body-file /tmp/mat-319-slice-a.md
```

The PR body must include the review-pipeline Invariants section, exact migration
cutover/rollback proof, and MAT-299/MAT-318/MAT-268 boundaries.

## Slice B — harness and model adapters

### Task 8: Define bounded harness/model registries

**Files:**
- Create: `packages/gateway/src/chat/harness-contract.ts`
- Create: `packages/gateway/src/chat/harness-registry.ts`
- Create: `packages/gateway/src/chat/model-registry.ts`
- Create: `tests/gateway/chat-harness-registry.test.ts`
- Create: `tests/gateway/chat-model-registry.test.ts`

**Interfaces:**
- Consumes: shared harness/model descriptor schemas and verified principal.
- Produces: `ChatHarnessAdapter<State>`, `ChatHarnessRegistry`,
  `ChatModelRegistry`, adapter state parsing, and capability resolution.

- [ ] **Step 1: Write failing registry tests**

```ts
expect(() => createHarnessRegistry(duplicateAdapters)).toThrow(/duplicate/i);
expect(() => createHarnessRegistry(twentyOneAdapters)).toThrow(/at most 20/i);
await expect(registry.resolve({ harnessId: "codex", modelId: "vision-only", rootChat: true }))
  .rejects.toMatchObject({ code: "capability_mismatch" });
```

Cover 64-model/128-tool caps, 2-second health timeout, bounded owner cache,
invalidation, secret/path-shaped descriptor metadata rejection, state 64-KiB
limit, schema-version mismatch, and the adapter-state rule that only a
schema-declared execution root validated against the owner project may contain
an absolute path.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/chat-harness-registry.test.ts tests/gateway/chat-model-registry.test.ts`
Expected: FAIL because registries are absent.

- [ ] **Step 3: Implement registries and adapter-only state envelope**

```ts
export interface AdapterStateEnvelope {
  harnessId: string;
  schemaVersion: number;
  state: unknown;
  encodedBytes: number;
}

resolve(input: ChatExecutionRequest): ResolvedHarnessModel {
  const harness = this.requireHarness(input.harnessId);
  const model = this.models.requireCompatible(harness, input.modelId);
  return { harness, model };
}
```

- [ ] **Step 4: Run registry tests and typecheck**

Run: `flox activate -- bun run test tests/gateway/chat-harness-registry.test.ts tests/gateway/chat-model-registry.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chat/harness-contract.ts packages/gateway/src/chat/harness-registry.ts packages/gateway/src/chat/model-registry.ts tests/gateway/chat-harness-registry.test.ts tests/gateway/chat-model-registry.test.ts
git commit -m "feat(chat): define harness capability registry"
```

### Task 9: Orchestrate start, resume, cancel, switch, and fork

**Files:**
- Create: `packages/gateway/src/chat/run-orchestrator.ts`
- Modify: `packages/gateway/src/chat/service.ts`
- Create: `tests/gateway/chat-run-orchestrator.test.ts`

**Interfaces:**
- Consumes: accepted Runs from Slice A, harness/model registries, adapter-only
  state repository, canonical history pages, and exact execution-root resolver.
- Produces: `startAcceptedRun`, `resumeRun`, `cancelRun`, and `forkChat`.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
await orchestrator.startAcceptedRun(codexRun.id);
await expect(orchestrator.resumeRun(codexRun.id, { harnessId: "pi" }))
  .rejects.toMatchObject({ code: "run_not_resumable" });
expect(pi.start).not.toHaveBeenCalledWith(expect.objectContaining({ adapterState: expect.anything() }));
expect((await repository.getRun(piRun.id)).baseMessageSeq).toBe(committedBoundary);
await moveRegisteredWorktree(piRun.executionRootRef);
await expect(orchestrator.resumeRun(piRun.id, { harnessId: "pi" }))
  .rejects.toMatchObject({ code: "run_not_resumable" });
```

Cover same-harness/version resume, incompatible version, Run retry attempt,
failed partial output exclusion, 200-message/2-MiB history window metadata,
late events, 500-event backpressure, explicit fork provenance, no active state
copy, cancellation timeout, restart interruption, and execution-root
fingerprint revalidation immediately before adapter start/resume.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/chat-run-orchestrator.test.ts`
Expected: FAIL because orchestration is absent.

- [ ] **Step 3: Implement lifecycle guards**

```ts
if (resume.harnessId !== run.harnessId || envelope.schemaVersion !== adapter.stateSchemaVersion) {
  throw new ChatRunError("run_not_resumable");
}
const history = await repository.readCanonicalHistory(run.chatId, {
  throughSeq: run.baseMessageSeq,
  maxMessages: 200,
  maxBytes: 2 * 1024 * 1024,
});
```

Persist each normalized event/status/outbox mutation transactionally. Call the
adapter outside the transaction and map failures to generic client state.

- [ ] **Step 4: Run orchestration and concurrency tests**

Run: `flox activate -- bun run test tests/gateway/chat-run-orchestrator.test.ts tests/gateway/chat-concurrency.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chat/run-orchestrator.ts packages/gateway/src/chat/service.ts tests/gateway/chat-run-orchestrator.test.ts
git commit -m "feat(chat): orchestrate provider-neutral runs"
```

### Task 10: Adapt Hermes and OpenClaw

**Files:**
- Create: `packages/gateway/src/chat/adapters/hermes.ts`
- Create: `packages/gateway/src/chat/adapters/openclaw.ts`
- Modify: `packages/gateway/src/server.ts`
- Create: `tests/gateway/chat-hermes-adapter.test.ts`
- Create: `tests/gateway/chat-openclaw-adapter.test.ts`

**Interfaces:**
- Consumes: existing Kernel query/resume seam, Hermes configuration source,
  OpenClaw configuration/runtime seam, normalized Run events.
- Produces: two `ChatHarnessAdapter` registrations; Hermes supports root/project
  Chat, OpenClaw advertises only proven capabilities.

- [ ] **Step 1: Write failing adapter contract tests**

```ts
expect((await hermes.describe(input)).supports.rootChat).toBe(true);
expect(await collect(hermes.start(runInput))).toEqual(expect.arrayContaining([
  expect.objectContaining({ type: "assistant.text.completed" }),
]));
expect(JSON.stringify(await collect(openclaw.start(runInput))))
  .not.toMatch(/\/home\/|token|raw stderr/i);
```

Cover session state validation, project working root, homePath preservation,
model capability projection, attachment/tool bounds, timeout/cancel, and generic
failure mapping.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/chat-hermes-adapter.test.ts tests/gateway/chat-openclaw-adapter.test.ts`
Expected: FAIL because adapters are absent.

- [ ] **Step 3: Implement adapters over existing runtime seams**

```ts
export const hermesChatAdapter: ChatHarnessAdapter<HermesResumeState> = {
  id: "hermes",
  stateSchemaVersion: 1,
  parseState: (value) => HermesResumeStateSchema.parse(value),
  serializeState: (value) => HermesResumeStateSchema.parse(value),
  describe,
  start,
  resume,
  cancel,
};
```

Do not move provider credentials or raw config into Chat state.

- [ ] **Step 4: Run adapter and Kernel tests**

Run: `flox activate -- bun run test tests/gateway/chat-hermes-adapter.test.ts tests/gateway/chat-openclaw-adapter.test.ts tests/kernel`
Expected: PASS for focused adapter tests and the repository's focused Kernel
suite.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chat/adapters packages/gateway/src/server.ts tests/gateway/chat-hermes-adapter.test.ts tests/gateway/chat-openclaw-adapter.test.ts
git commit -m "feat(chat): adapt os chat harnesses"
```

### Task 11: Bridge Codex, Pi, and OpenCode adapters

**Files:**
- Create: `packages/gateway/src/chat/adapters/coding-agent.ts`
- Modify: `packages/gateway/src/coding-agents/provider-adapter.ts`
- Modify: `packages/gateway/src/coding-agents/provider-registry.ts`
- Modify: `packages/gateway/src/server.ts`
- Create: `tests/gateway/chat-coding-agent-adapter.test.ts`

**Interfaces:**
- Consumes: existing bounded coding-agent adapter events and provider resume
  state.
- Produces: Chat harness registrations for Codex, Pi, and OpenCode while legacy
  thread routes remain compatibility projections until Slice C.

- [ ] **Step 1: Write failing bridge tests**

```ts
for (const harnessId of ["codex", "pi", "opencode"]) {
  const descriptor = await registry.describe(owner, harnessId);
  expect(descriptor.id).toBe(harnessId);
  expect(descriptor.workspaceRequirement).toBe("project_required");
}
await expect(runWith({ harnessId: "pi", stateFrom: "codex" }))
  .rejects.toMatchObject({ code: "run_not_resumable" });
```

Cover tool/approval/input projection, provider event ownership, secret/path
sanitization, cancellation, project requirement, exact adapter-state version,
valid Pi `cwd` preservation and resume after owner-project revalidation,
registered sibling-worktree and external-folder fixtures, unregistered or
ambiguous sibling/stale path quarantine, no path projection, and compatibility
projection parity.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/chat-coding-agent-adapter.test.ts`
Expected: FAIL because the bridge is absent.

- [ ] **Step 3: Add one generic coding-agent bridge with registrations**

```ts
export function createCodingAgentChatAdapter(
  provider: CodingAgentProviderAdapter,
): ChatHarnessAdapter<CodingAgentProviderResumeState> {
  return {
    id: provider.providerId,
    stateSchemaVersion: 1,
    parseState: (value) => CodingAgentProviderResumeStateSchema.parse(value),
    serializeState: (value) => CodingAgentProviderResumeStateSchema.parse(value),
    describe: (input) => describeCodingHarness(provider, input),
    start: (input) => bridgeStart(provider, input),
    resume: provider.resumeTurn ? (input) => bridgeResume(provider, input) : undefined,
    cancel: provider.abortThread ? (input) => bridgeCancel(provider, input) : undefined,
  };
}
```

- [ ] **Step 4: Run Slice B validation**

Run: `flox activate -- bun run test tests/gateway/chat-harness-*.test.ts tests/gateway/chat-model-registry.test.ts tests/gateway/chat-run-orchestrator.test.ts tests/gateway/chat-coding-agent-adapter.test.ts`
Then: `flox activate -- bun run typecheck && bun run check:patterns:diff`
Expected: PASS with no new pattern violations.

- [ ] **Step 5: Commit and open Slice B PR**

```bash
git add packages/gateway/src/chat packages/gateway/src/coding-agents packages/gateway/src/server.ts tests/gateway
git commit -m "feat(chat): complete harness adapter bridge"
git push -u origin HEAD
gh pr create --title "feat(chat): add provider-neutral harness adapters" --body-file /tmp/mat-319-slice-b.md
```

## Slice C — shell and UI migration

### Task 12: Move browser Shell to canonical Chat APIs/events

**Files:**
- Create: `shell/src/lib/chat-contract.ts`
- Modify: `shell/src/stores/chat-context.tsx`
- Modify: `shell/src/hooks/useConversation.ts`
- Modify: `shell/src/hooks/useChatState.ts`
- Create: `tests/shell/chat-context.test.tsx`

**Interfaces:**
- Consumes: `/api/chats`, Chat event replay, strict shared schemas.
- Produces: one runtime-scoped browser Chat store with list/detail/create/switch,
  Turn, cancel, fork, export, delete, and replay actions.

- [ ] **Step 1: Write failing browser store tests**

```ts
expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/files/system/conversations"), expect.anything());
await store.switchRuntime("next-runtime");
oldListRequest.resolve(oldRuntimeChats);
expect(store.getState().items).toEqual([]);
expect(store.getState().error).toBeNull();
```

Cover loading/empty/error/reconnect/replay gap, mutation failure preservation,
safe error allowlist, same Chat after harness change, export/delete, and no
filesystem watcher authority.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/shell/chat-context.test.tsx`
Expected: FAIL because canonical browser state is absent.

- [ ] **Step 3: Implement validated API/event client and store**

```ts
const page = ChatPageSchema.parse(await response.json());
if (generation !== currentGeneration()) return;
set({ items: page.items, status: "ready", error: null });
```

Remove direct transcript JSON reads and use the outbox replay cursor. Keep any
compatibility hook as a pure projection over the canonical store.

- [ ] **Step 4: Run browser focused tests and typecheck**

Run: `flox activate -- bun run test tests/shell/chat-context.test.tsx && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shell/src/lib/chat-contract.ts shell/src/stores/chat-context.tsx shell/src/hooks/useConversation.ts shell/src/hooks/useChatState.ts tests/shell/chat-context.test.tsx
git commit -m "feat(shell): use canonical chat contracts"
```

### Task 13: Replace Desktop source-typed rails with Chat projections

**Files:**
- Create: `desktop/src/renderer/src/stores/chats.ts`
- Modify: `desktop/src/renderer/src/features/chat/ChatTab.tsx`
- Modify: `desktop/src/renderer/src/stores/hermes-chat.ts`
- Modify: `desktop/src/renderer/src/stores/threads.ts`
- Delete: `desktop/src/renderer/src/stores/unified-threads.ts`
- Modify: `desktop/src/main/index.ts`
- Create: `desktop/src/main/chat/event-stream.ts`
- Create: `tests/desktop/chat-store.test.ts`
- Modify: `tests/desktop/chat-tab.test.tsx`

**Interfaces:**
- Consumes: canonical Chat HTTP/event contracts through authenticated Desktop
  main-process wiring.
- Produces: one bounded runtime-scoped Chat rail; harness/model/project are
  labels/capabilities, never item source types.

- [ ] **Step 1: Write failing Desktop store/UI tests**

```ts
expect(railItems.map((item) => item.id)).toEqual([chatA.id, chatB.id]);
expect(railItems.map((item) => item)).not.toEqual(expect.arrayContaining([
  expect.objectContaining({ source: "kernel" }),
]));
expect(screen.getByText("Codex")).toBeInTheDocument(); // capability label
expect(activeChat.id).toBe(chatA.id); // unchanged after harness switch
```

Cover create/list/load/switch, root/project unavailable state, model/harness
capability menus, active Run, approval/input attention, reconnect/replay gap,
runtime generation invalidation, failed mutation preservation, export/delete,
and stable Zustand selectors.

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/desktop/chat-store.test.ts tests/desktop/chat-tab.test.tsx`
Expected: FAIL because Desktop still owns source-typed rails.

- [ ] **Step 3: Implement the canonical projection and remove identity ownership**

```ts
interface DesktopChatsState {
  runtimeScope: string | null;
  items: ChatSummary[];
  activeChatId: string | null;
  activeChat: ChatDetail | null;
  eventCursor: string | null;
}
```

Keep composer draft/optimistic stream state transient. Remove `AgentThread.id`
and Hermes session identity as rail authorities only after their canonical Chat
mapping exists. Do not add localStorage, IndexedDB, or main-process files.

- [ ] **Step 4: Run Desktop focused tests and React checks**

Run: `flox activate -- bun run test tests/desktop/chat-store.test.ts tests/desktop/chat-tab.test.tsx && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/src desktop/src/main tests/desktop
git commit -m "feat(desktop): unify canonical chat rail"
```

### Task 14: Migrate CLI and channel shells

**Files:**
- Modify: `bin/cli.ts`
- Modify: `bin/matrixos.ts`
- Modify: `packages/gateway/src/server.ts`
- Modify: `packages/gateway/src/channels/types.ts`
- Modify: `packages/gateway/src/channels/manager.ts`
- Create: `packages/gateway/src/chat/channel-bindings.ts`
- Create: `tests/cli/chat.test.ts`
- Create: `tests/gateway/chat-channel-bindings.test.ts`

**Interfaces:**
- Consumes: canonical Chat service/API and authenticated principal-to-owner
  mapping.
- Produces: CLI list/open/send/export/delete and server-owned channel-thread to
  Chat bindings.

- [ ] **Step 1: Write failing CLI and channel-binding tests**

```ts
expect(await cli.run(["chat", "list"])).toContain(chat.id);
expect(await channelBinding.resolve(channelPrincipal, externalThreadId)).toEqual({ chatId: chat.id });
expect(channelRequest).not.toHaveProperty("ownerId");
```

- [ ] **Step 2: Run tests and verify Red**

Run: `flox activate -- bun run test tests/cli/chat.test.ts tests/gateway/chat-channel-bindings.test.ts`
Expected: FAIL because canonical commands/bindings are absent.

- [ ] **Step 3: Route both shells through canonical Gateway/service seams**

```ts
const owner = ownerFromVerifiedPrincipal(principal);
const binding = await chatBindings.resolveOrCreate(owner, {
  channelId,
  externalThreadId,
  clientRequestId,
});
return chatService.admitTurn(owner, binding.chatId, request);
```

Persist safe channel binding IDs owner-locally; no provider session, credential,
or owner override enters a client payload.

- [ ] **Step 4: Run CLI/channel tests**

Run: `flox activate -- bun run test tests/cli/chat.test.ts tests/gateway/chat-channel-bindings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/cli.ts bin/matrixos.ts packages/gateway/src/server.ts packages/gateway/src/channels packages/gateway/src/chat/channel-bindings.ts tests/cli/chat.test.ts tests/gateway/chat-channel-bindings.test.ts
git commit -m "feat(chat): converge cli and channel shells"
```

### Task 15: Prove cutover and remove legacy runtime writes

**Files:**
- Modify/delete: `packages/gateway/src/conversations.ts` after import/cutover
  compatibility has no remaining runtime caller.
- Modify: `packages/gateway/src/coding-agents/thread-store.ts` to expose only the
  compatibility projection or remove JSON persistence after all callers move.
- Modify: `packages/gateway/src/server.ts`
- Modify: `packages/kernel/src/boot.ts`
- Create: `tests/e2e/chat-cutover.test.ts`
- Create: `desktop/e2e/chat-provider-neutral.spec.ts`

**Interfaces:**
- Consumes: completed migration marker, canonical shells, adapter bridge.
- Produces: no post-marker JSON writes and runtime proof across Browser,
  Desktop, CLI, restart, harness switch, export, and delete.

- [ ] **Step 1: Write failing no-dual-write and E2E tests**

```ts
await sendTurnAfterCutover(chat.id);
expect(await legacyConversationFiles()).toEqual(beforeFiles);
expect(await canonicalMessages(chat.id)).toContainEqual(expect.objectContaining({ role: "user" }));
await switchHarness(chat.id, "pi");
expect(await currentChatId()).toBe(chat.id);
expect(await resumedForeignProviderState()).toBe(false);
```

Cover repeated migration, browser/Desktop/CLI convergence, project-bound cwd,
root harness rejection when project-required, restart same-harness resume,
cross-harness fresh Run, unavailable project, replay gap, hard delete, export
parity, and old-binary startup refusal.

- [ ] **Step 2: Run E2E tests and verify Red before removals**

Run: `flox activate -- bun run test tests/e2e/chat-cutover.test.ts`
Expected: FAIL while legacy writers/callers remain.

- [ ] **Step 3: Remove post-marker writers and direct JSON readers**

```ts
if (await migrations.hasCutoverMarker()) {
  return createCanonicalChatServices(sharedKysely);
}
return createPreCutoverMigrationServices();
```

Delete compatibility code only when `rg` proves no supported caller. Keep
original owner JSON files untouched as backup material; remove runtime writes,
not owner data.

- [ ] **Step 4: Run Slice C and full proportional validation**

Run:

```bash
flox activate -- bun run test tests/contracts/chat.test.ts tests/gateway/chat-*.test.ts tests/shell/chat-context.test.tsx tests/desktop/chat-store.test.ts tests/cli/chat.test.ts tests/e2e/chat-cutover.test.ts
flox activate -- bun run typecheck
flox activate -- bun run check:patterns
flox activate -- bun run test
flox activate -- bun run build:shell:production
flox activate -- bun run build:desktop
```

Then run `desktop/e2e/chat-provider-neutral.spec.ts` against the exact built
Electron worktree/commit and record screenshots plus database/JSON fingerprints.
Expected: focused suites, typecheck, pattern scan, and builds pass. Report any
pre-existing full-suite failures separately with exact counts; never call the
repository green from focused evidence alone.

- [ ] **Step 5: Commit and open Slice C PR**

```bash
git add packages/gateway packages/kernel shell desktop bin packages/cli tests
git commit -m "feat(chat): complete canonical shell cutover"
git push -u origin HEAD
gh pr create --title "feat(chat): migrate shells to canonical chats" --body-file /tmp/mat-319-slice-c.md
```

The PR body must include exact worktree/commit/runtime evidence, no-dual-write
proof, MAT-299/MAT-318 sequencing, MAT-268 exclusion, and the Invariants section.

### Task 16: Publish public documentation separately

**Repository:** `FinnaAI/matrix-os-site` in its own worktree and PR.

**Files:** Resolve the current Fumadocs Chat guide path in that repository with
`rg --files content/docs | rg 'chat|conversation|project'` before editing.

**Interfaces:**
- Consumes: merged runtime behavior and verified screenshots/evidence.
- Produces: public-safe Chat ownership, harness switching, project context,
  export/delete, and migration-facing user guidance.

- [ ] **Step 1: Write a documentation acceptance checklist**

```md
- Chat identity remains stable when harness/model changes.
- Chat content stays on the owner's Matrix computer/VPS.
- Project context references an owner project without exposing local paths.
- Export/delete and unavailable-project recovery are explained.
```

- [ ] **Step 2: Run the site repository's documented docs test before edits**

Run the exact command from that repository's `AGENTS.md`; record the baseline
exit code and do not invent a monorepo `www/` command.

- [ ] **Step 3: Add public-safe content and verified images**

Use product behavior only. Exclude customer identifiers, private hostnames,
tokens, database credentials, incident details, and operator-only migration
commands.

- [ ] **Step 4: Run the site docs build/link checks**

Expected: PASS with no broken links or missing images.

- [ ] **Step 5: Open the separate conventional documentation PR**

Use a title such as `docs(chat): explain durable chats and harness switching`,
attach it to the relevant Chat follow-up issue, and keep it separate from the
Matrix OS runtime PRs.

## Final verification and review gates for every slice

Before claiming a slice complete:

1. Re-read `specs/113-provider-neutral-chat-architecture/spec.md` and map every
   changed requirement to a fresh command or inspected artifact.
2. Run `git diff --check`, `bun run typecheck`, `bun run check:patterns:diff`,
   and all focused tests for the slice.
3. Run the broader `bun run test` gate before push; report unrelated baseline
   failures separately with exact counts and logs.
4. Perform the review-pipeline mechanical, trust-boundary, and
   atomicity/failure-mode passes.
5. Freeze the review commit range and request Greptile. Resolve all Critical and
   Important findings, especially auth, row-lock, outbox, cutover, shutdown,
   and provider-state findings.
6. Read back the GitHub PR title/body/files/checks/reviewer state and Linear
   attachment/state. A wrapper success response is not completion evidence.
7. Never merge without explicit user approval. Keep Linear at `PR In Review`
   until merge.
