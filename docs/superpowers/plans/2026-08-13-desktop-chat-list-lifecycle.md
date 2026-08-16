# Desktop Chat List Search and Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete MAT-299 with the Figma-approved Chats index, bounded local search, and safe row-level deletion of idle Hermes conversations.

**Architecture:** The Gateway `ConversationStore` remains canonical. A Gateway lifecycle coordinator shares one capped per-conversation serializer across existing-session run admission, active-run registration, deletion, finalization, and future context mutation. Desktop derives search results locally from the bounded Gateway index and mutates its cache only after an authenticated delete succeeds for the current runtime generation.

**Tech Stack:** TypeScript 5.5+ strict ESM, React 19, Zustand, Hono, Zod 4 via `zod/v4`, Vitest, Electron, Flox, pnpm 10, bun.

## Global Constraints

- Continue the existing MAT-299 branch, worktree, and draft PR; do not create a competing conversation-index implementation.
- Gateway ConversationStore is the source of truth; Desktop is a bounded cache and must not add renderer-owned persistence.
- Search is case-insensitive over the loaded title and preview only; it is not full-transcript search.
- Delete is row-level on hover and keyboard focus; there is no Select mode, bulk delete, archive, or rename.
- A running conversation cannot be deleted; the Gateway active-run registry is authoritative, and its begin/complete transitions participate in the same per-conversation critical section as destructive mutations.
- Every mutating route uses `bodyLimit`, Zod boundary validation, bounded safe error codes, and authenticated existing Gateway routing.
- Filesystem mutation is async, atomic where writing is involved, symlink-safe, and serialized with finalize/context mutation under a capped keyed lock.
- TDD is mandatory: every implementation step follows Red -> Green -> Refactor.
- MAT-268, Voice, collaboration avatars, project/repository context, and Figma Sandbox explorations are excluded.
- Public user documentation ships as a separate PR in `FinnaAI/matrix-os-site` under `content/docs/`.

---

## File Structure

- `packages/contracts/src/index.ts`: shared conversation delete response and safe error-code schemas.
- `packages/gateway/src/conversation-mutation-lock.ts`: capped, idle-evicted per-conversation async serializer shared by run admission, delete, finalize, and future context mutations.
- `packages/gateway/src/conversations.ts`: async conversation persistence and symlink-safe delete operation.
- `packages/gateway/src/server/conversation-history-routes.ts`: validated GET/DELETE conversation routes and response mapping.
- `packages/gateway/src/conversation-run-registry.ts`: authoritative `isActive(sessionId)` query.
- `packages/gateway/src/server.ts`: inject the shared serializer, admit an existing-session run under it before provider dispatch, keep the run active through finalization, and remove the inline DELETE route.
- `desktop/src/renderer/src/stores/hermes-chat.ts`: runtime-safe delete mutation and bounded safe error state.
- `desktop/src/renderer/src/features/chat/conversation-search.ts`: pure query normalization/filter helper.
- `desktop/src/renderer/src/features/chat/DeleteConversationDialog.tsx`: focused confirmation/pending/error UI.
- `desktop/src/renderer/src/features/chat/HermesConversationIndex.tsx`: Figma-aligned Chats header, Search/New chat, flat rows, hover/focus delete action.
- `tests/contracts/kernel-conversations.test.ts`, `tests/gateway/conversations.test.ts`, `tests/gateway/conversation-history-routes.test.ts`, `tests/gateway/conversation-run-registry.test.ts`, `tests/desktop/hermes-chat.test.ts`, `tests/desktop/hermes-conversation-index.test.tsx`, `tests/e2e/desktop/hermes-conversations.e2e.test.ts`: contract, unit, component, and real-app coverage.

### Task 1: Define the bounded delete contract

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `tests/contracts/kernel-conversations.test.ts`

**Interfaces:**
- Consumes: existing `KernelConversationIdSchema`.
- Produces: `KernelConversationDeleteResponseSchema`, `KernelConversationMutationErrorCodeSchema`, and their inferred types.

- [ ] **Step 1: Write failing contract tests**

```ts
expect(KernelConversationDeleteResponseSchema.parse({ ok: true })).toEqual({ ok: true });
expect(KernelConversationMutationErrorCodeSchema.safeParse("conversation_busy").success).toBe(true);
expect(KernelConversationMutationErrorCodeSchema.safeParse("/Users/name/private").success).toBe(false);
```

- [ ] **Step 2: Run the focused contract test and verify Red**

Run: `flox activate -- bun run test tests/contracts/kernel-conversations.test.ts`

Expected: FAIL because the two exported schemas do not exist.

- [ ] **Step 3: Add strict schemas and inferred types**

```ts
export const KernelConversationDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export const KernelConversationMutationErrorCodeSchema = z.enum([
  "invalid_conversation_id",
  "conversation_not_found",
  "conversation_busy",
  "conversation_delete_unavailable",
]);
export type KernelConversationDeleteResponse = z.infer<typeof KernelConversationDeleteResponseSchema>;
export type KernelConversationMutationErrorCode = z.infer<typeof KernelConversationMutationErrorCodeSchema>;
```

- [ ] **Step 4: Run the focused contract test and verify Green**

Run: `flox activate -- bun run test tests/contracts/kernel-conversations.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/contracts/src/index.ts tests/contracts/kernel-conversations.test.ts
git commit -m "feat(contracts): define conversation delete response"
```

### Task 2: Make ConversationStore deletion async, serialized, and symlink-safe

**Files:**
- Create: `packages/gateway/src/conversation-mutation-lock.ts`
- Create: `tests/gateway/conversation-mutation-lock.test.ts`
- Modify: `packages/gateway/src/conversations.ts`
- Modify: `tests/gateway/conversations.test.ts`

**Interfaces:**
- Consumes: `KernelConversationId` from `@matrix-os/contracts`.
- Produces: `ConversationMutationLock.run<T>(id, operation): Promise<T>` and `ConversationStore.delete(id): Promise<"deleted" | "not_found">`.

- [ ] **Step 1: Write failing lock tests for same-ID serialization, different-ID concurrency, cap, and cleanup**

```ts
const lock = createConversationMutationLock({ maxKeys: 2 });
const order: string[] = [];
const first = lock.run("a", async () => { order.push("a:start"); await gate; order.push("a:end"); });
const second = lock.run("a", async () => { order.push("a:second"); });
expect(order).toEqual(["a:start"]);
release();
await Promise.all([first, second]);
expect(order).toEqual(["a:start", "a:end", "a:second"]);
expect(lock.size).toBe(0);
```

- [ ] **Step 2: Run the lock test and verify Red**

Run: `flox activate -- bun run test tests/gateway/conversation-mutation-lock.test.ts`

Expected: FAIL because `createConversationMutationLock` does not exist.

- [ ] **Step 3: Implement a capped keyed promise chain**

```ts
export interface ConversationMutationLock {
  run<T>(id: string, operation: () => Promise<T>): Promise<T>;
  readonly size: number;
}

export function createConversationMutationLock(options: { maxKeys: number }): ConversationMutationLock {
  const tails = new Map<string, Promise<void>>();
  return {
    get size() { return tails.size; },
    async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
      if (!tails.has(id) && tails.size >= options.maxKeys) throw new Error("conversation mutation capacity reached");
      const previous = tails.get(id) ?? Promise.resolve();
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const current = previous.catch(() => undefined).then(() => barrier);
      tails.set(id, current);
      await previous.catch(() => undefined);
      try { return await operation(); }
      finally {
        release();
        if (tails.get(id) === current) {
          await current;
          tails.delete(id);
        }
      }
    },
  };
}
```

- [ ] **Step 4: Write failing ConversationStore delete tests**

```ts
await expect(store.delete(validId)).resolves.toBe("deleted");
await expect(store.delete(validId)).resolves.toBe("not_found");
await symlink(outsideFile, join(homePath, "system/conversations", `${otherId}.json`));
await expect(store.delete(otherId)).rejects.toThrow("conversation record is not a regular file");
```

Also assert that a finalize queued behind delete cannot recreate the deleted record and that filesystem errors do not clear active buffers before unlink succeeds.

- [ ] **Step 5: Run ConversationStore tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/conversations.test.ts`

Expected: FAIL because `delete` is synchronous/boolean and follows symlinks through `existsSync`/`unlinkSync`.

- [ ] **Step 6: Implement async safe deletion under the shared lock**

Use `lstat`, `unlink`, `readFile`, `readdir`, and `mkdir` from `node:fs/promises`; reject non-files; convert write/finalize boundaries needed by the lock to awaited operations; clear `active`, `buffers`, and `lastTouched` only after unlink succeeds.

```ts
delete(id) {
  return mutationLock.run(id, async () => {
    let stats;
    try { stats = await lstat(filePath(id)); }
    catch (error) { if (isNodeError(error, "ENOENT")) return "not_found"; throw error; }
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("conversation record is not a regular file");
    await unlink(filePath(id));
    active.delete(id); buffers.delete(id); lastTouched.delete(id);
    return "deleted" as const;
  });
}
```

- [ ] **Step 7: Run both gateway unit suites and verify Green**

Run: `flox activate -- bun run test tests/gateway/conversation-mutation-lock.test.ts tests/gateway/conversations.test.ts`

Expected: PASS with no unhandled promise rejection.

- [ ] **Step 8: Commit the persistence boundary**

```bash
git add packages/gateway/src/conversation-mutation-lock.ts packages/gateway/src/conversations.ts tests/gateway/conversation-mutation-lock.test.ts tests/gateway/conversations.test.ts
git commit -m "refactor(gateway): serialize conversation mutations"
```

### Task 3: Enforce active-run-safe deletion at the HTTP boundary

**Files:**
- Modify: `packages/gateway/src/conversation-run-registry.ts`
- Modify: `tests/gateway/conversation-run-registry.test.ts`
- Modify: `packages/gateway/src/server/conversation-history-routes.ts`
- Modify: `tests/gateway/conversation-history-routes.test.ts`
- Modify: `packages/gateway/src/server.ts`

**Interfaces:**
- Consumes: `ConversationStore.delete`, `KernelConversationIdSchema`, `ConversationRunRegistry`.
- Produces: `ConversationRunRegistry.isActive(sessionId): boolean` and authenticated `DELETE /api/conversations/:id`.

- [ ] **Step 1: Write failing registry and route tests**

```ts
registry.begin("conversation-1");
expect(registry.isActive("conversation-1")).toBe(true);
registry.complete("conversation-1");
expect(registry.isActive("conversation-1")).toBe(false);
```

Route cases must assert 400 invalid ID, 409 active run without unlinking, 404 stale record, 200 `{ok:true}`, 413 oversized DELETE body, and 503 with `{error:{code:"conversation_delete_unavailable"}}` on internal failure. Add both race orders: delete holds the serializer before admission (admission fails because the record is gone), and admission registers the run before delete (delete returns 409).

- [ ] **Step 2: Run focused route tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/conversation-run-registry.test.ts tests/gateway/conversation-history-routes.test.ts`

Expected: FAIL because `isActive`, DELETE registration, and `bodyLimit` are absent.

- [ ] **Step 3: Add the authoritative active query**

```ts
isActive(sessionId: string): boolean {
  const run = this.runs.get(sessionId);
  return Boolean(run && run.completedAt === null);
}
```

- [ ] **Step 4: Register DELETE beside history GET**

Extend route dependencies with the lifecycle coordinator, apply `bodyLimit({maxSize: 512})`, validate `:id` before coordinator access, and map only bounded codes. `deleteIfIdle` must acquire the shared serializer and perform the authoritative active-run check and filesystem mutation inside that one critical section; the route must not pre-check `isActive` outside the lock.

```ts
app.delete("/api/conversations/:id", deleteBodyLimit, async (c) => {
  const id = KernelConversationIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: { code: "invalid_conversation_id" } }, 400);
  try {
    const result = await deps.conversationLifecycle.deleteIfIdle(id.data);
    if (result === "busy") return c.json({ error: { code: "conversation_busy" } }, 409);
    if (result === "not_found") return c.json({ error: { code: "conversation_not_found" } }, 404);
    return c.json(KernelConversationDeleteResponseSchema.parse({ ok: true }));
  } catch (error) {
    console.error("[gateway] Failed to delete conversation:", error);
    return c.json({ error: { code: "conversation_delete_unavailable" } }, 503);
  }
});
```

- [ ] **Step 5: Serialize existing-session admission and completion**

Inject the same serializer into the conversation store and lifecycle coordinator. Before dispatching a turn with an existing `sessionId`, acquire its key, confirm the canonical record still exists, resolve required execution context, and call `conversationRuns.begin` before releasing the lock. New conversations have no deletable canonical ID before `kernel:init`; register their generated ID synchronously before exposing it to mutations. On every terminal path, finalize durable state and call `conversationRuns.complete` inside one serialized operation, keeping the run active until persistence settles. Then delete the old unvalidated inline DELETE route.

- [ ] **Step 6: Run route, auth, and metrics tests and verify Green**

Run: `flox activate -- bun run test tests/gateway/conversation-history-routes.test.ts tests/gateway/conversation-run-registry.test.ts tests/gateway/auth.test.ts tests/gateway/metrics.test.ts`

Expected: PASS; the route remains protected by the existing Gateway auth middleware.

- [ ] **Step 7: Commit the Gateway route**

```bash
git add packages/gateway/src/conversation-run-registry.ts packages/gateway/src/server/conversation-history-routes.ts packages/gateway/src/server.ts tests/gateway/conversation-run-registry.test.ts tests/gateway/conversation-history-routes.test.ts
git commit -m "feat(gateway): delete idle conversations safely"
```

### Task 4: Add runtime-safe Desktop deletion state

**Files:**
- Modify: `desktop/src/renderer/src/stores/hermes-chat.ts`
- Modify: `tests/desktop/hermes-chat.test.ts`

**Interfaces:**
- Consumes: `ApiClient.delete`, `KernelConversationIdSchema`, `AppError.detail`, runtime generation helpers.
- Produces: `deletingConversationId`, `deleteError`, `deleteConversation(api,id): Promise<boolean>`, and `clearDeleteError()`.

- [ ] **Step 1: Write failing store tests**

```ts
const result = await useHermesChat.getState().deleteConversation(api, "conversation-1");
expect(result).toBe(true);
expect(useHermesChat.getState().conversations.map((item) => item.id)).not.toContain("conversation-1");
```

Cover invalid IDs without I/O, pending state, selected transcript clearing only on success, busy/generic safe copy, 404 refresh, rejected request preserving the row, duplicate-submit suppression, and runtime-generation change discarding a late response.

- [ ] **Step 2: Run the store test and verify Red**

Run: `flox activate -- bun run test tests/desktop/hermes-chat.test.ts`

Expected: FAIL because deletion state/actions do not exist.

- [ ] **Step 3: Implement the allowlisted mutation**

```ts
deleteConversation: async (api, id) => {
  const parsed = KernelConversationIdSchema.safeParse(id);
  if (!parsed.success || get().deletingConversationId) return false;
  const generation = captureRuntimeGeneration();
  set({ deletingConversationId: parsed.data, deleteError: null });
  try {
    await api.delete(`/api/conversations/${encodeURIComponent(parsed.data)}`);
    if (!isCurrentRuntimeGeneration(generation)) return false;
    set((state) => ({
      conversations: state.conversations.filter((item) => item.id !== parsed.data),
      ...(state.sessionId === parsed.data ? { sessionId: null, messages: [], view: "index" as const } : {}),
      deletingConversationId: null,
    }));
    return true;
  } catch (error) {
    if (!isCurrentRuntimeGeneration(generation)) return false;
    // Map only conversation_busy/not_found; unknown details use generic copy.
    set({ deletingConversationId: null, deleteError: safeConversationDeleteMessage(error) });
    if (isConversationNotFound(error)) await get().refreshConversations(api);
    return false;
  }
}
```

- [ ] **Step 4: Run the store test and verify Green**

Run: `flox activate -- bun run test tests/desktop/hermes-chat.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the renderer mutation**

```bash
git add desktop/src/renderer/src/stores/hermes-chat.ts tests/desktop/hermes-chat.test.ts
git commit -m "feat(desktop): manage conversation deletion state"
```

### Task 5: Implement the Figma-approved Chats index

**Files:**
- Create: `desktop/src/renderer/src/features/chat/conversation-search.ts`
- Create: `desktop/src/renderer/src/features/chat/DeleteConversationDialog.tsx`
- Create: `tests/desktop/hermes-conversation-index.test.tsx`
- Modify: `desktop/src/renderer/src/features/chat/HermesConversationIndex.tsx`

**Interfaces:**
- Consumes: `HermesConversationSummary`, `deleteConversation`, `deletingConversationId`, `deleteError`.
- Produces: `normalizeConversationQuery`, `filterConversations`, accessible Search/New chat/row Delete UI.

- [ ] **Step 1: Write failing pure search tests**

```ts
expect(normalizeConversationQuery("  BuILD  ")).toBe("build");
expect(filterConversations(items, "launch").map((item) => item.id)).toEqual(["title-hit", "preview-hit"]);
expect(filterConversations(items, "   ")).toBe(items);
```

- [ ] **Step 2: Implement the pure helper and verify it**

Run before implementation: `flox activate -- bun run test tests/desktop/hermes-conversation-index.test.tsx`

Expected: FAIL because the helper is missing.

```ts
export function normalizeConversationQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}
export function filterConversations(items: HermesConversationSummary[], query: string) {
  const normalized = normalizeConversationQuery(query);
  if (!normalized) return items;
  return items.filter(({ title, preview }) => `${title}\n${preview}`.toLocaleLowerCase().includes(normalized));
}
```

- [ ] **Step 3: Write failing component tests for header, focus, filtering, and deletion**

```tsx
expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
await user.click(screen.getByRole("button", { name: "Search chats" }));
expect(screen.getByRole("searchbox", { name: "Search chats" })).toHaveFocus();
await user.tab();
expect(screen.getByRole("button", { name: "Delete Launch plan" })).toBeTruthy();
```

Assert Escape closes search, no-match copy differs from empty/loading/error, delete click does not open the row, cancel sends no request, confirm is single-flight, running row explains why deletion is unavailable, and no Select control exists.

- [ ] **Step 4: Build focused dialog and flat row components**

Use `Dialog` and `Button variant="danger"` from `design/primitives`; make the delete button a sibling of the row-open button so nested interactive elements are avoided. Use `group-hover`, `group-focus-within`, `pointer-events-none`, `focus:pointer-events-auto`, and visible focus rings without layout shift.

```tsx
<button aria-label={`Delete ${conversation.title}`} disabled={running || deleting} onClick={(event) => {
  event.stopPropagation();
  setDeleteTarget(conversation);
}}>
  <Trash2 size={14} aria-hidden />
</button>
```

- [ ] **Step 5: Align the header and list states**

Render `Chats`, icon-only `Search chats`, and `New chat`; use `useMemo(() => filterConversations(conversations, query), [conversations, query])`; clear query when Search closes and when the runtime resets the canonical index; keep New chat available in no-match state.

- [ ] **Step 6: Run component and accessibility tests and verify Green**

Run: `flox activate -- bun run test tests/desktop/hermes-conversation-index.test.tsx tests/desktop/hermes-chat.test.ts`

Expected: PASS with no nested-button or missing accessible-name warnings.

- [ ] **Step 7: Commit the Figma-aligned UI**

```bash
git add desktop/src/renderer/src/features/chat/conversation-search.ts desktop/src/renderer/src/features/chat/DeleteConversationDialog.tsx desktop/src/renderer/src/features/chat/HermesConversationIndex.tsx tests/desktop/hermes-conversation-index.test.tsx
git commit -m "feat(desktop): add chat search and row deletion"
```

### Task 6: Verify the full flow and deliver MAT-299

**Files:**
- Modify: `tests/e2e/desktop/hermes-conversations.e2e.test.ts`
- Create in site repository: `content/docs/desktop/chat-conversations.mdx`
- Modify: MAT-299 draft PR body and Linear issue comments in English.

**Interfaces:**
- Consumes: complete Gateway and Desktop behavior from Tasks 1-5.
- Produces: deterministic E2E proof, real Electron screenshots, public docs PR, and review-ready MAT-299 PR.

- [ ] **Step 1: Add E2E coverage for search/delete/restart**

```ts
test("searches and deletes an idle persisted Hermes conversation", async ({ page }) => {
  await openChats(page);
  await page.getByRole("button", { name: "Search chats" }).click();
  await page.getByRole("searchbox", { name: "Search chats" }).fill("release plan");
  await expect(page.getByRole("button", { name: /Release plan conversation/ })).toBeVisible();
  await page.getByRole("button", { name: "Delete Release plan" }).click();
  await page.getByRole("button", { name: "Delete chat" }).click();
  await expect(page.getByText("Release plan")).toHaveCount(0);
});
```

- [ ] **Step 2: Run focused and package gates**

Run:

```bash
flox activate -- bun run test tests/contracts/kernel-conversations.test.ts tests/gateway/conversation-mutation-lock.test.ts tests/gateway/conversations.test.ts tests/gateway/conversation-history-routes.test.ts tests/gateway/conversation-run-registry.test.ts tests/desktop/hermes-chat.test.ts tests/desktop/hermes-conversation-index.test.tsx
flox activate -- pnpm --filter @matrix-os/contracts typecheck
flox activate -- pnpm --filter @matrix-os/gateway typecheck
flox activate -- pnpm --filter matrix-os-desktop typecheck
flox activate -- bun run build:desktop
```

Expected: all focused tests, typechecks, and Desktop production build PASS.

- [ ] **Step 3: Run real Electron verification under Flox**

Launch the MAT-299 worktree with an isolated `OPERATOR_USER_DATA_DIR` and remote-debugging port; verify empty/loading/stale/no-match, pointer hover, keyboard focus, cancel, success, active-run conflict, restart persistence, reconnect, and runtime-switch invalidation. Capture equal-viewport screenshots of default, search, hover, confirmation, and busy states.

- [ ] **Step 4: Create the separate public docs PR**

In a manual `FinnaAI/matrix-os-site` worktree, document that Search filters loaded chat summaries and Delete permanently removes one idle chat after confirmation. Do not document bulk selection, archive, or MAT-268.

- [ ] **Step 5: Commit E2E proof and update delivery metadata**

```bash
git add tests/e2e/desktop/hermes-conversations.e2e.test.ts
git commit -m "test(desktop): verify chat search and deletion"
```

Update the existing MAT-299 PR in English with source-of-truth, lock scope, acceptable orphan states, auth source of truth, deferred scope, exact test commands, screenshots, and the separate docs PR link. Keep Linear at `PR In Review` until merge and request Greptile review; resolve or explicitly defer every finding with a linked issue before merge.

## Self-Review Result

- Spec coverage: Search, Figma header/row behavior, active-run protection, safe Gateway deletion, runtime invalidation, error allowlisting, Electron evidence, public docs, and exclusions all map to Tasks 1-6.
- Placeholder scan: no placeholder markers or vague implementation instructions remain.
- Type consistency: `ConversationStore.delete`, `ConversationRunRegistry.isActive`, contract schema names, and Desktop store action names are consistent across tasks.
