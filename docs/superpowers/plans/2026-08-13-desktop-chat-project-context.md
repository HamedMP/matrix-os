# Desktop Chat Project and Repository Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Desktop Chat’s Add to project and Repository controls truthful and persistent by resolving one canonical `projectId` into a validated per-turn Kernel working directory.

**Architecture:** Conversation records persist only a project reference. The Gateway derives safe display context and a validated internal working directory from the canonical owner-scoped ProjectManager; Desktop never sends a path, and Kernel keeps `homePath` for identity/system data while using an optional `cwd` for the current dispatch.

**Tech Stack:** TypeScript 5.5+ strict ESM, React 19, Zustand, Hono, Zod 4 via `zod/v4`, Claude Agent SDK V1 `query()` with `resume`, Vitest, Electron, Flox, pnpm 10, bun.

## Global Constraints

- Depend on MAT-299 canonical Gateway-backed persistent conversations; do not add renderer-owned conversation persistence.
- Persist only `{ projectId }`; never persist or expose `localPath`, repository URL, branch, owner scope, or runtime identity in the conversation record/API.
- `Add to project` and `Repository` converge on the same `projectId`; one Matrix project currently owns at most one repository/folder root.
- Context affects future turns only and never rewrites history.
- Gateway resolves ProjectConfig at mutation and dispatch time; invalid, archived, deleting, missing, or inaccessible context blocks send with no silent Matrix-home fallback.
- Context mutation is rejected while the conversation has an active run and is serialized with finalize/delete under the bounded conversation mutation lock.
- The WebSocket client message schema gains no path field.
- Kernel `homePath` remains the identity/system root; only SDK `cwd` changes for the dispatch.
- TDD is mandatory: every implementation step follows Red -> Green -> Refactor.
- Voice, collaboration, multi-repository projects, worktree selection, branch switching/git status, broad Chat/coding-agent unification, and MAT-268 are excluded.
- Public user documentation ships as a separate PR in `FinnaAI/matrix-os-site` under `content/docs/`.

---

## File Structure

- `packages/contracts/src/index.ts`: strict context mutation, projection, list/history response schemas.
- `packages/gateway/src/conversations.ts`: optional persisted context, atomic async update, shared mutation lock.
- `packages/gateway/src/conversation-context.ts`: owner-scoped ProjectConfig resolution and safe projection without paths.
- `packages/gateway/src/server/conversation-history-routes.ts`: `PATCH /api/conversations/:id/context` plus safe projection in reads.
- `packages/gateway/src/dispatcher.ts`: optional internal `workingDirectory` dispatch value.
- `packages/kernel/src/options.ts`: optional `workingDirectory` on `KernelConfig`, used as SDK `cwd` while `homePath` remains unchanged.
- `packages/gateway/src/server.ts`: ProjectManager/context resolver injection and dispatch-time lookup before registering an active run.
- `desktop/src/renderer/src/stores/hermes-chat.ts`: validated context projection and runtime-safe context mutation.
- `desktop/src/renderer/src/features/chat/ConversationContextPicker.tsx`: active project picker with loading/empty/error/stale states.
- `desktop/src/renderer/src/features/chat/ChatTab.tsx`: real project/repository controls and send blocking/recovery actions.
- Contract, Gateway, Kernel, Dispatcher, Desktop, and Electron tests listed in the tasks below.

### Task 1: Define strict shared context contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `tests/contracts/kernel-conversations.test.ts`

**Interfaces:**
- Consumes: `KernelConversationIdSchema`, `ProjectIdSchema`.
- Produces: `KernelConversationContextUpdateSchema`, `KernelConversationContextProjectionSchema`, `KernelConversationSummarySchema`, and context-aware history response fields.

- [ ] **Step 1: Write failing schema tests**

```ts
expect(KernelConversationContextUpdateSchema.parse({ projectId: "matrix-os" })).toEqual({ projectId: "matrix-os" });
expect(KernelConversationContextUpdateSchema.parse({ projectId: null })).toEqual({ projectId: null });
expect(KernelConversationContextUpdateSchema.safeParse({ projectId: "matrix-os", localPath: "/repo" }).success).toBe(false);
expect(KernelConversationContextProjectionSchema.safeParse({
  projectId: "matrix-os", projectName: "Matrix OS", projectKind: "github",
  repositoryLabel: "FinnaAI/matrix-os", status: "ready",
}).success).toBe(true);
```

- [ ] **Step 2: Run the contract test and verify Red**

Run: `flox activate -- bun run test tests/contracts/kernel-conversations.test.ts`

Expected: FAIL because the context schemas are absent.

- [ ] **Step 3: Add strict schemas and inferred types**

```ts
export const KernelConversationContextUpdateSchema = z.object({ projectId: ProjectIdSchema.nullable() }).strict();
export const KernelConversationContextProjectionSchema = z.object({
  projectId: ProjectIdSchema,
  projectName: z.string().min(1).max(160),
  projectKind: z.enum(["scratch", "github", "folder"]),
  repositoryLabel: z.string().min(1).max(200).optional(),
  status: z.enum(["ready", "unavailable"]),
}).strict();
```

Extend the bounded list summary and history response with `context: KernelConversationContextProjectionSchema.optional()`; keep all schemas strict so `localPath` is rejected.

- [ ] **Step 4: Run the contract test and verify Green**

Run: `flox activate -- bun run test tests/contracts/kernel-conversations.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the context contract**

```bash
git add packages/contracts/src/index.ts tests/contracts/kernel-conversations.test.ts
git commit -m "feat(contracts): define conversation project context"
```

### Task 2: Persist only projectId under the shared mutation lock

**Files:**
- Modify: `packages/gateway/src/conversations.ts`
- Modify: `tests/gateway/conversations.test.ts`

**Interfaces:**
- Consumes: MAT-299 `ConversationMutationLock` and async atomic persistence.
- Produces: `ConversationFile.context?: {projectId:string}` and `ConversationStore.updateContext(id, projectId): Promise<"updated" | "not_found">`.

- [ ] **Step 1: Write failing persistence tests**

```ts
await expect(store.updateContext(id, "matrix-os")).resolves.toBe("updated");
expect((await store.get(id))?.context).toEqual({ projectId: "matrix-os" });
await expect(store.updateContext(id, null)).resolves.toBe("updated");
expect((await store.get(id))?.context).toBeUndefined();
```

Also reopen the store from disk, assert only `projectId` persisted, assert a write failure preserves the previous record, and queue update/finalize/delete for the same ID to verify one serial order.

- [ ] **Step 2: Run ConversationStore tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/conversations.test.ts`

Expected: FAIL because context and `updateContext` do not exist.

- [ ] **Step 3: Extend the record and mutation interface**

```ts
export interface ConversationContext { projectId: string }
export interface ConversationFile {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
  context?: ConversationContext;
}
```

Implement `updateContext` inside the existing mutation lock, create a new object rather than mutating shared state, update `updatedAt`, and persist with the same temp-file/fsync/rename helper used by finalize.

- [ ] **Step 4: Run persistence tests and verify Green**

Run: `flox activate -- bun run test tests/gateway/conversations.test.ts tests/gateway/conversation-mutation-lock.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit canonical persistence**

```bash
git add packages/gateway/src/conversations.ts tests/gateway/conversations.test.ts
git commit -m "feat(gateway): persist conversation project references"
```

### Task 3: Resolve project references into safe projections

**Files:**
- Create: `packages/gateway/src/conversation-context.ts`
- Create: `tests/gateway/conversation-context.test.ts`
- Modify: `packages/gateway/src/project-manager.ts`

**Interfaces:**
- Consumes: `ProjectManager.getProject(slug)`, `ProjectConfig`, verified owner scope.
- Produces: `ConversationContextResolver.resolve(projectId): Promise<ResolvedConversationContext>` where internal data includes `workingDirectory` and public data does not.

- [ ] **Step 1: Write failing resolver tests**

```ts
await expect(resolver.resolve("matrix-os")).resolves.toEqual({
  projection: {
    projectId: "matrix-os", projectName: "Matrix OS", projectKind: "github",
    repositoryLabel: "FinnaAI/matrix-os", status: "ready",
  },
  workingDirectory: project.localPath,
});
expect(JSON.stringify((await resolver.resolve("matrix-os")).projection)).not.toContain(project.localPath);
```

Cover scratch/folder labels, missing, archived, deleting, owner-scope mismatch, and a canonical path that no longer resolves to an eligible directory.

- [ ] **Step 2: Run resolver tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/conversation-context.test.ts`

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement internal/public type separation**

```ts
export interface ResolvedConversationContext {
  projection: KernelConversationContextProjection;
  workingDirectory: string;
}

export function createConversationContextResolver(projectManager: ProjectManager) {
  return {
    async resolve(projectId: string): Promise<ResolvedConversationContext | null> {
      const result = await projectManager.getProject(projectId);
      if (!result.ok) return null;
      const project = result.project;
      return {
        workingDirectory: project.localPath,
        projection: {
          projectId: project.slug,
          projectName: project.name,
          projectKind: project.kind,
          ...(project.github ? { repositoryLabel: `${project.github.owner}/${project.github.repo}` } : { repositoryLabel: project.name }),
          status: "ready",
        },
      };
    },
  };
}
```

Keep path validation in the canonical ProjectManager; do not accept any renderer-supplied path or metadata.

- [ ] **Step 4: Run resolver and ProjectManager tests and verify Green**

Run: `flox activate -- bun run test tests/gateway/conversation-context.test.ts tests/gateway/project-manager.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the resolver**

```bash
git add packages/gateway/src/conversation-context.ts packages/gateway/src/project-manager.ts tests/gateway/conversation-context.test.ts
git commit -m "feat(gateway): resolve conversation project context"
```

### Task 4: Add the authenticated context mutation route and safe reads

**Files:**
- Modify: `packages/gateway/src/server/conversation-history-routes.ts`
- Modify: `tests/gateway/conversation-history-routes.test.ts`
- Modify: `packages/gateway/src/server.ts`

**Interfaces:**
- Consumes: context schemas, `ConversationRunRegistry.isActive`, `ConversationStore.updateContext`, `ConversationContextResolver`.
- Produces: `PATCH /api/conversations/:id/context` and context projection in GET list/history.

- [ ] **Step 1: Write failing HTTP tests**

```ts
const response = await app.request(authenticated("/api/conversations/conversation-1/context", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ projectId: "matrix-os" }),
}));
expect(response.status).toBe(200);
expect(await response.json()).toEqual({ context: readyProjection });
```

Cover strict-body rejection of `localPath`, 413 body limit, invalid conversation/project IDs, 404 conversation/project, 409 active run, 503 storage failure, clearing with null, safe unavailable projection on list/history, and response JSON never containing absolute paths.

- [ ] **Step 2: Run route tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/conversation-history-routes.test.ts`

Expected: FAIL because PATCH and projected read context are absent.

- [ ] **Step 3: Register the route with exact mutation ordering**

Apply `bodyLimit({maxSize:4096})`, parse ID/body before dependency access, reject an active run, resolve an active project before persistence, then call `updateContext`. Clearing skips project resolution. Return only `{context: projection}` or `{context:null}`.

```ts
const body = KernelConversationContextUpdateSchema.safeParse(await c.req.json());
if (!body.success) return c.json({ error: { code: "invalid_conversation_context" } }, 400);
if (deps.conversationRuns.isActive(id.data)) return c.json({ error: { code: "conversation_busy" } }, 409);
const resolved = body.data.projectId ? await deps.contextResolver.resolve(body.data.projectId) : null;
if (body.data.projectId && !resolved) return c.json({ error: { code: "project_unavailable" } }, 404);
```

- [ ] **Step 4: Project context in list/history without changing their ownership model**

Resolve projections server-side; cap concurrent projection resolution with a fixed worker count and preserve list order. Missing context returns `status:"unavailable"` with safe persisted project ID and no path. Never expose internal resolution errors.

- [ ] **Step 5: Run route, auth, and contract tests and verify Green**

Run: `flox activate -- bun run test tests/gateway/conversation-history-routes.test.ts tests/gateway/auth.test.ts tests/contracts/kernel-conversations.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the context API**

```bash
git add packages/gateway/src/server/conversation-history-routes.ts packages/gateway/src/server.ts tests/gateway/conversation-history-routes.test.ts
git commit -m "feat(gateway): expose conversation project context"
```

### Task 5: Plumb internal workingDirectory through Dispatcher and Kernel

**Files:**
- Modify: `packages/gateway/src/dispatcher.ts`
- Modify: `tests/gateway/dispatcher-overrides.test.ts`
- Modify: `packages/kernel/src/options.ts`
- Modify: `tests/kernel/options.test.ts`

**Interfaces:**
- Consumes: Gateway-only validated project `localPath`.
- Produces: `KernelDispatchOverrides.workingDirectory?: string`, `KernelConfig.workingDirectory?: string`, SDK `cwd: workingDirectory ?? homePath`.

- [ ] **Step 1: Write failing Dispatcher isolation tests**

```ts
await dispatcher.dispatch("status", "session-1", onEvent, undefined, undefined, {
  workingDirectory: "/validated/repo-a",
});
expect(spawnFn).toHaveBeenCalledWith("status", expect.objectContaining({
  homePath,
  workingDirectory: "/validated/repo-a",
}), undefined);
```

Dispatch a second queued conversation with no context and assert it gets no inherited working directory.

- [ ] **Step 2: Write failing Kernel option tests**

```ts
const options = await kernelOptions({ db, homePath, workingDirectory: repoPath });
expect(options.cwd).toBe(repoPath);
expect(createIpcServer).toHaveBeenCalledWith(db, homePath);
expect(buildSystemPrompt).toHaveBeenCalledWith(homePath, db);
```

- [ ] **Step 3: Run both tests and verify Red**

Run: `flox activate -- bun run test tests/gateway/dispatcher-overrides.test.ts tests/kernel/options.test.ts`

Expected: FAIL because `workingDirectory` is not part of either config.

- [ ] **Step 4: Add the internal-only field**

```ts
export interface KernelDispatchOverrides {
  model?: KernelModel;
  effort?: KernelEffort;
  workingDirectory?: string;
}
export interface KernelConfig {
  db: MatrixDB;
  homePath: string;
  workingDirectory?: string;
  // existing fields remain
}
```

Copy it into each serial queue entry/config and set `cwd: config.workingDirectory ?? homePath` in `kernelOptions`. Do not add it to batch entries, browser messages, public HTTP, or WebSocket schemas.

- [ ] **Step 5: Run Dispatcher/Kernel tests and verify Green**

Run: `flox activate -- bun run test tests/gateway/dispatcher-overrides.test.ts tests/gateway/dispatcher-concurrent.test.ts tests/kernel/options.test.ts`

Expected: PASS with independent cwd per concurrent/queued dispatch.

- [ ] **Step 6: Commit dispatch plumbing**

```bash
git add packages/gateway/src/dispatcher.ts packages/kernel/src/options.ts tests/gateway/dispatcher-overrides.test.ts tests/kernel/options.test.ts
git commit -m "feat(kernel): support validated per-turn working directory"
```

### Task 6: Resolve context at WebSocket dispatch time

**Files:**
- Modify: `packages/gateway/src/server.ts`
- Modify: `tests/e2e/api/conversations.e2e.test.ts`
- Modify: `tests/contracts/gateway-websocket.test.ts`

**Interfaces:**
- Consumes: selected conversation ID, ConversationStore context, ConversationContextResolver, Dispatcher override.
- Produces: send blocking for stale context and internal `workingDirectory` delivery without a client path field.

- [ ] **Step 1: Write failing full-path tests**

```ts
socket.send(JSON.stringify({ type: "message", text: "pwd", requestId: "req-1", sessionId }));
await waitForAck(socket, "req-1", "accepted");
expect(dispatch).toHaveBeenCalledWith("pwd", sessionId, expect.any(Function), undefined, expect.any(AbortController), expect.objectContaining({
  workingDirectory: project.localPath,
}));
```

Assert a client message with `workingDirectory` or `path` is rejected by the existing strict schema; stale project context sends a bounded `project_context_unavailable` error and never calls dispatch; no-context conversations continue with Matrix home behavior.

- [ ] **Step 2: Run WebSocket tests and verify Red**

Run: `flox activate -- bun run test tests/contracts/gateway-websocket.test.ts tests/e2e/api/conversations.e2e.test.ts`

Expected: FAIL because dispatch does not resolve context.

- [ ] **Step 3: Resolve before accepting the run**

For an existing `sessionId`, read the conversation and resolve its context before creating abort/run registry entries or sending accepted ack. If context is unavailable, send the safe error and leave the transcript readable. Pass only the internal directory through `KernelDispatchOverrides`.

- [ ] **Step 4: Run full-path tests and verify Green**

Run: `flox activate -- bun run test tests/contracts/gateway-websocket.test.ts tests/e2e/api/conversations.e2e.test.ts tests/gateway/conversation-history-routes.test.ts`

Expected: PASS; WebSocket wire payloads contain no filesystem path.

- [ ] **Step 5: Commit Gateway-to-Kernel wiring**

```bash
git add packages/gateway/src/server.ts tests/contracts/gateway-websocket.test.ts tests/e2e/api/conversations.e2e.test.ts
git commit -m "feat(gateway): dispatch chats in project context"
```

### Task 7: Add runtime-safe Desktop context state and picker

**Files:**
- Modify: `desktop/src/renderer/src/stores/hermes-chat.ts`
- Modify: `tests/desktop/hermes-chat.test.ts`
- Create: `desktop/src/renderer/src/features/chat/ConversationContextPicker.tsx`
- Create: `tests/desktop/conversation-context-picker.test.tsx`

**Interfaces:**
- Consumes: context contracts, `useBoard.projects`, `ApiClient.patch`, runtime generation helpers.
- Produces: selected projection, loading/error state, `updateConversationContext`, active-project picker.

- [ ] **Step 1: Write failing store tests**

```ts
await expect(useHermesChat.getState().updateConversationContext(api, sessionId, "matrix-os")).resolves.toBe(true);
expect(useHermesChat.getState().conversationContext).toEqual(readyProjection);
expect(api.patch).toHaveBeenCalledWith(`/api/conversations/${sessionId}/context`, { projectId: "matrix-os" });
```

Cover null clear, strict response parsing, previous context preserved on failure, busy/stale safe copy, duplicate-submit suppression, and runtime-switch invalidation.

- [ ] **Step 2: Run store tests and verify Red**

Run: `flox activate -- bun run test tests/desktop/hermes-chat.test.ts`

Expected: FAIL because context state/actions are absent.

- [ ] **Step 3: Implement runtime-safe mutation and parsing**

Capture the runtime generation and a mutation sequence; parse the request project ID and response projection with shared schemas; update only when both generation and sequence still match. Map only bounded error codes to user copy and retain the prior projection on error.

- [ ] **Step 4: Write failing picker tests**

```tsx
await user.click(screen.getByRole("button", { name: "Add to project" }));
expect(screen.getByRole("option", { name: /Matrix OS.*GitHub.*FinnaAI\/matrix-os/ })).toBeTruthy();
await user.click(screen.getByRole("option", { name: /Matrix OS/ }));
expect(onSelect).toHaveBeenCalledWith("matrix-os");
```

Test loading, empty, project-list error, selected, stale, remove, Escape, keyboard navigation, and disabled-during-run states.

- [ ] **Step 5: Implement the focused picker**

Use existing Desktop popover/menu primitives and `useBoard` active projects. Display name/kind and `owner/repo` for GitHub projects; display a safe name for folder/scratch projects; never render `localPath`. The empty-state action calls the existing project-creation surface.

- [ ] **Step 6: Run store and picker tests and verify Green**

Run: `flox activate -- bun run test tests/desktop/hermes-chat.test.ts tests/desktop/conversation-context-picker.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit Desktop context state**

```bash
git add desktop/src/renderer/src/stores/hermes-chat.ts desktop/src/renderer/src/features/chat/ConversationContextPicker.tsx tests/desktop/hermes-chat.test.ts tests/desktop/conversation-context-picker.test.tsx
git commit -m "feat(desktop): manage persistent chat project context"
```

### Task 8: Replace static composer pills with truthful controls

**Files:**
- Modify: `desktop/src/renderer/src/features/chat/ChatTab.tsx`
- Create: `tests/desktop/hermes-chat-context.test.tsx`

**Interfaces:**
- Consumes: `ConversationContextPicker`, Hermes context projection/mutation, active `HermesStatus`.
- Produces: Add to project/Repository controls, stale recovery, and blocked-send behavior.

- [ ] **Step 1: Write failing composer tests**

```tsx
expect(screen.getByRole("button", { name: "Add to project" })).toBeTruthy();
expect(screen.queryByText("main")).toBeNull();
await selectProject("Matrix OS");
expect(screen.getByRole("button", { name: "Project Matrix OS" })).toBeTruthy();
expect(screen.getByRole("button", { name: "Repository FinnaAI/matrix-os" })).toBeTruthy();
```

Assert context is loaded from history/index rather than `projects[0]`, controls are disabled during a turn, stale context blocks Send with Choose another project/Remove project context actions, and a failed recovery retains the stale label.

- [ ] **Step 2: Run component tests and verify Red**

Run: `flox activate -- bun run test tests/desktop/hermes-chat-context.test.tsx`

Expected: FAIL because `ChatTab` renders hard-coded project/VPS/main pills.

- [ ] **Step 3: Replace the fake footer**

Remove `projects[0]`, `On VPS`, and `main`. Render `Add to project` when unselected, then project and repository buttons from the Gateway projection. Both buttons open the same picker; Repository is omitted when no repository/folder label exists.

- [ ] **Step 4: Block send only for unresolved persisted context**

Derive `contextBlocksSend = conversationContext?.status === "unavailable"`; include it in `canSubmitChatDraft`; show safe inline recovery copy and actions without clearing transcript or silently falling back to home.

- [ ] **Step 5: Run Chat component suites and verify Green**

Run: `flox activate -- bun run test tests/desktop/hermes-chat-context.test.tsx tests/desktop/chat-tab-render.test.tsx tests/desktop/conversation.test.tsx`

Expected: PASS and no fake branch label remains.

- [ ] **Step 6: Commit truthful composer controls**

```bash
git add desktop/src/renderer/src/features/chat/ChatTab.tsx tests/desktop/hermes-chat-context.test.tsx
git commit -m "feat(desktop): connect chat composer to project context"
```

### Task 9: Verify persistence, dispatch, recovery, and delivery

**Files:**
- Modify: `tests/e2e/desktop/hermes-conversations.e2e.test.ts`
- Create in site repository: `content/docs/desktop/chat-project-context.mdx`
- Update: implementation PR and Linear issue in English.

**Interfaces:**
- Consumes: complete context flow from Tasks 1-8.
- Produces: restart/reconnect/runtime evidence, public docs PR, and review-ready implementation PR.

- [ ] **Step 1: Add real-flow Electron E2E coverage**

```ts
test("persists project context and dispatches future turns in its repository", async ({ page }) => {
  await selectConversation(page, "Release plan");
  await page.getByRole("button", { name: "Add to project" }).click();
  await page.getByRole("option", { name: /Matrix OS/ }).click();
  await restartDesktopRenderer(page);
  await expect(page.getByRole("button", { name: "Project Matrix OS" })).toBeVisible();
  await sendMessage(page, "Report the current repository name");
  await expect(page.getByText(/matrix-os/i)).toBeVisible();
});
```

Add stale-project recovery, active-run mutation rejection, reconnect, and runtime-switch tests.

- [ ] **Step 2: Run focused and package gates**

Run:

```bash
flox activate -- bun run test tests/contracts/kernel-conversations.test.ts tests/gateway/conversations.test.ts tests/gateway/conversation-context.test.ts tests/gateway/conversation-history-routes.test.ts tests/gateway/dispatcher-overrides.test.ts tests/kernel/options.test.ts tests/contracts/gateway-websocket.test.ts tests/desktop/hermes-chat.test.ts tests/desktop/conversation-context-picker.test.tsx tests/desktop/hermes-chat-context.test.tsx
flox activate -- pnpm --filter @matrix-os/contracts typecheck
flox activate -- pnpm --filter @matrix-os/gateway typecheck
flox activate -- pnpm --filter @matrix-os/kernel typecheck
flox activate -- pnpm --filter matrix-os-desktop typecheck
flox activate -- bun run build:desktop
```

Expected: all focused tests, typechecks, and Desktop production build PASS.

- [ ] **Step 3: Run real Electron verification under Flox**

Use an isolated manual worktree, `OPERATOR_USER_DATA_DIR`, and debug port. Verify project selection, repository label, future-turn cwd, unchanged Kernel home identity, close/reopen persistence, reconnect, stale archived/deleting/missing recovery, mutation during an active turn, and runtime switching. Capture equal-viewport screenshots for empty, picker, selected, stale, and recovery states.

- [ ] **Step 4: Create the separate public docs PR**

In a manual `FinnaAI/matrix-os-site` worktree, document how a chat is associated with one project and how future turns run in that project. Explicitly state that branch/worktree selection and multi-repository context are not yet supported.

- [ ] **Step 5: Commit E2E proof and prepare review**

```bash
git add tests/e2e/desktop/hermes-conversations.e2e.test.ts
git commit -m "test(desktop): verify persistent project chat context"
```

Open the implementation PR with source-of-truth, lock scope, acceptable orphan states, auth source of truth, deferred scope, exact tests, screenshots, and docs PR link. Set the Linear issue to `PR In Review`, request Greptile review, and do not merge until every finding is fixed or explicitly deferred to a linked follow-up issue.

## Self-Review Result

- Spec coverage: Canonical persistence, safe projection, context API, active-run locking, dispatch-time resolution, Kernel cwd/home split, Desktop picker/recovery, Electron proof, docs, and exclusions map to Tasks 1-9.
- Placeholder scan: no placeholder markers or vague implementation instructions remain.
- Type consistency: shared schema names, `ConversationStore.updateContext`, `ResolvedConversationContext`, `workingDirectory`, and Desktop context action names are consistent across tasks.
