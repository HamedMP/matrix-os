# Desktop Hermes Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Desktop-native graphical Hermes configuration modal whose user flow matches the browser Shell, including explicit refresh and foreground-terminal fallback.

**Architecture:** The Gateway remains the configuration authority. Bounded Hermes schemas live in `@matrix-os/contracts`; Electron main performs authenticated Gateway calls behind typed IPC; Desktop renders its own modal and form components. Shell keeps its existing UI and gains the same explicit refresh semantics without sharing React state or styling.

**Tech Stack:** TypeScript 5.9 strict ESM, Zod 4, React 19, Electron 41, Radix Dialog, Vitest, Testing Library, pnpm 10.33.4, Bun.

## Global Constraints

- Work only in the manual `codex/mat-262-hermes-desktop-setup` worktree based on `origin/main`.
- Follow TDD for every behavior: failing test, minimal implementation, passing focused test, refactor.
- Use pnpm for dependency operations and Bun for repository scripts; never npm.
- Do not add persistence. Gateway and Hermes remain authoritative.
- Do not return stored credential values to Desktop or Shell; reads contain metadata only and writes are bounded.
- Every request and response boundary uses strict Zod validation, bounded collections, and fixed safe client errors.
- Read requests use a 10 second timeout; writes use a 15 second timeout.
- Do not log request bodies, credential values, raw provider errors, private hosts, or filesystem paths.
- Keep the existing foreground-terminal setup path as an explicit compatibility fallback.
- Desktop uses its own design tokens and primitives; do not share Shell JSX or visual tokens.
- Keep composition files under 500 lines where practical; extract focused field and credential components.
- Update public user documentation through a separate `FinnaAI/matrix-os-site` PR after behavior is finalized.

---

### Task 1: Shared Hermes configuration contracts

**Files:**
- Create: `packages/contracts/src/hermes-configuration.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/gateway/src/routes/hermes.ts`
- Modify: `shell/src/lib/hermes-configuration.ts`
- Test: `tests/contracts/hermes-configuration.test.ts`
- Test: `tests/gateway/hermes-proxy.test.ts`
- Test: `tests/shell/hermes-configuration.test.tsx`

**Interfaces:**
- Produces: `HermesConfigurationSchema`, `HermesEnvironmentSchema`, `HermesConfigurationChangeRequestSchema`, `HermesCredentialSetRequestSchema`, `HermesCredentialRemoveRequestSchema`, `HermesMutationResponseSchema` and their inferred types.
- Consumes: Zod 4 only.

- [x] **Step 1: Write failing contract tests**

Add tests that prove valid dynamic configuration parses, more than 1,024 fields is rejected, more than 64 changes is rejected, unsupported nested values are rejected, environment entries expose metadata only, and a response containing a `value` secret is rejected.

```ts
import {
  HermesConfigurationChangeRequestSchema,
  HermesConfigurationSchema,
  HermesEnvironmentSchema,
} from "@matrix-os/contracts";

it("rejects stored credential values in environment reads", () => {
  expect(HermesEnvironmentSchema.safeParse({
    ANTHROPIC_API_KEY: {
      is_set: true,
      value: "secret",
      description: "Anthropic",
      category: "model",
      is_password: true,
      tools: [],
      advanced: false,
      channel_managed: false,
      provider: "anthropic",
      provider_label: "Anthropic",
    },
  }).success).toBe(false);
});

it("caps a configuration mutation at 64 changes", () => {
  const changes = Array.from({ length: 65 }, (_, index) => ({
    path: `general.field_${index}`,
    value: true,
  }));
  expect(HermesConfigurationChangeRequestSchema.safeParse({ changes }).success).toBe(false);
});
```

- [x] **Step 2: Run the new contract tests and verify red**

Run: `flox activate -- bun run test -- tests/contracts/hermes-configuration.test.ts`

Expected: FAIL because the Hermes schemas are not exported.

- [x] **Step 3: Implement the bounded shared schemas**

Create a focused contract module with strict objects and these types:

```ts
export type HermesConfigValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>;

export const HermesConfigurationSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  defaults: z.record(z.string(), z.unknown()),
  fields: z.record(HermesConfigPathSchema, HermesConfigFieldSchema)
    .refine((fields) => Object.keys(fields).length <= 1_024),
  categoryOrder: z.array(z.string().max(64)).max(64),
}).strict();
```

Use a package-local import alias in `packages/contracts/package.json`, export the module from `index.ts`, replace the duplicate Shell response schemas, and reuse the shared request schemas at Gateway route boundaries. Keep Gateway-sensitive-path filtering and schema-aware value checks in the Gateway.

- [x] **Step 4: Run contract, Gateway, and Shell tests and verify green**

Run: `flox activate -- bun run test -- tests/contracts/hermes-configuration.test.ts tests/gateway/hermes-proxy.test.ts tests/shell/hermes-configuration.test.tsx`

Expected: all selected tests PASS.

- [x] **Step 5: Commit the contract slice**

```bash
git add packages/contracts packages/gateway/src/routes/hermes.ts shell/src/lib/hermes-configuration.ts tests/contracts/hermes-configuration.test.ts tests/gateway/hermes-proxy.test.ts tests/shell/hermes-configuration.test.tsx
git commit -m "feat(contracts): share Hermes configuration schemas"
```

---

### Task 2: Trusted Desktop Hermes client and typed IPC

**Files:**
- Create: `desktop/src/main/hermes/configuration-client.ts`
- Modify: `desktop/src/shared/ipc-contract.ts`
- Modify: `desktop/src/main/ipc/handlers.ts`
- Modify: `desktop/src/main/index.ts`
- Test: `tests/desktop/hermes-configuration-client.test.ts`
- Test: `tests/desktop/ipc-contract.test.ts`
- Test: `tests/desktop/ipc-handlers.test.ts`

**Interfaces:**
- Consumes: shared Hermes schemas from Task 1 and `AuthService`.
- Produces: five typed IPC channels named in the approved design and main-client functions with matching request/response types.

- [x] **Step 1: Write failing main-client tests**

Cover bearer authentication, selected runtime query routing, 10/15 second abort signals, strict response validation, generic errors, bounded request validation, and DELETE bodies.

```ts
it("routes configuration reads through the selected runtime", async () => {
  fetchMock.mockResolvedValue(response(configuration));
  await fetchHermesConfiguration(authWithRuntime("preview"), fetchMock);
  expect(fetchMock).toHaveBeenCalledWith(
    "https://app.matrix-os.com/api/hermes/configuration?runtime=preview",
    expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer device-token" }),
    }),
  );
});

it("never exposes an upstream body when a write fails", async () => {
  fetchMock.mockResolvedValue(new Response("provider failed at /home/matrix", { status: 502 }));
  await expect(updateHermesConfiguration(auth, { changes: [{ path: "general.model", value: "x" }] }, fetchMock))
    .rejects.toThrow("Hermes configuration could not be saved.");
});
```

- [x] **Step 2: Run the client test and verify red**

Run: `flox activate -- bun run test -- tests/desktop/hermes-configuration-client.test.ts`

Expected: FAIL because `desktop/src/main/hermes/configuration-client.ts` does not exist.

- [x] **Step 3: Implement the trusted main client**

Export these functions:

```ts
export function fetchHermesConfiguration(auth: AuthService, fetchFn?: FetchFn): Promise<HermesConfiguration>;
export function fetchHermesEnvironment(auth: AuthService, fetchFn?: FetchFn): Promise<HermesEnvironment>;
export function updateHermesConfiguration(auth: AuthService, request: HermesConfigurationChangeRequest, fetchFn?: FetchFn): Promise<{ ok: true }>;
export function setHermesCredential(auth: AuthService, request: HermesCredentialSetRequest, fetchFn?: FetchFn): Promise<{ ok: true }>;
export function removeHermesCredential(auth: AuthService, request: HermesCredentialRemoveRequest, fetchFn?: FetchFn): Promise<{ ok: true }>;
```

Build URLs from `auth.getGatewayOrigin()` and `auth.getStatus().runtimeSlot`, require `auth.getToken()`, parse all bodies with shared schemas, and throw only `Hermes configuration is unavailable.` or `Hermes configuration could not be saved.`.

- [x] **Step 4: Write failing IPC contract and handler tests**

Assert malformed paths, keys, and oversized credential values are rejected in preload/main contracts; valid calls reach the injected handler dependency; returned secrets or malformed responses are rejected.

```ts
expect(INVOKE_CHANNELS["runtime:set-hermes-credential"].request.safeParse({
  key: "ANTHROPIC_API_KEY",
  value: "x".repeat(4_097),
}).success).toBe(false);
```

- [x] **Step 5: Add the typed IPC channels and registration-time dependencies**

Extend `INVOKE_CHANNELS` with:

```ts
"runtime:get-hermes-configuration": { request: Empty, response: HermesConfigurationSchema },
"runtime:get-hermes-environment": { request: Empty, response: HermesEnvironmentSchema },
"runtime:update-hermes-configuration": { request: HermesConfigurationChangeRequestSchema, response: HermesMutationResponseSchema },
"runtime:set-hermes-credential": { request: HermesCredentialSetRequestSchema, response: HermesMutationResponseSchema },
"runtime:remove-hermes-credential": { request: HermesCredentialRemoveRequestSchema, response: HermesMutationResponseSchema },
```

Add five required functions to `HandlerContext`, register them directly, and inject the Task 2 main-client functions from `desktop/src/main/index.ts`.

- [x] **Step 6: Run Desktop client and IPC tests and verify green**

Run: `flox activate -- bun run test -- tests/desktop/hermes-configuration-client.test.ts tests/desktop/ipc-contract.test.ts tests/desktop/ipc-handlers.test.ts`

Expected: all selected tests PASS.

- [x] **Step 7: Commit the trusted transport slice**

```bash
git add desktop/src/main/hermes/configuration-client.ts desktop/src/shared/ipc-contract.ts desktop/src/main/ipc/handlers.ts desktop/src/main/index.ts tests/desktop/hermes-configuration-client.test.ts tests/desktop/ipc-contract.test.ts tests/desktop/ipc-handlers.test.ts
git commit -m "feat(desktop): add Hermes configuration IPC"
```

---

### Task 3: Desktop form model and native modal

**Files:**
- Create: `desktop/src/renderer/src/features/settings/hermes/hermes-form-model.ts`
- Create: `desktop/src/renderer/src/features/settings/hermes/HermesSettingEditor.tsx`
- Create: `desktop/src/renderer/src/features/settings/hermes/HermesCredentialRow.tsx`
- Create: `desktop/src/renderer/src/features/settings/hermes/HermesConfigurationDialog.tsx`
- Test: `tests/desktop/hermes-form-model.test.ts`
- Test: `tests/desktop/hermes-configuration-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 contract types and Task 2 IPC channels through `invoke()`.
- Produces: `HermesConfigurationDialog({ open, version, onClose, onOpenSetupTerminal, onConfigurationChanged })`.

- [x] **Step 1: Write failing pure-model tests**

Test category ordering/counts, settings and credential search, nested value access, typed list parsing, draft comparison, and stale revision rejection.

```ts
it("searches all categories without changing the selected category", () => {
  expect(matchingConfigurationFields(configuration, "context", "general").map(([path]) => path))
    .toEqual(["agent.model_context_length"]);
});

it("accepts only bounded scalar JSON lists", () => {
  expect(parseHermesList('["codex", 2, true]')).toEqual(["codex", 2, true]);
  expect(parseHermesList('[{"secret":"x"}]')).toBeNull();
});
```

- [x] **Step 2: Run the model tests and verify red**

Run: `flox activate -- bun run test -- tests/desktop/hermes-form-model.test.ts`

Expected: FAIL because the form-model module does not exist.

- [x] **Step 3: Implement the focused pure model**

Export `titleCase`, `configValueAt`, `setConfigValue`, `configurationCategories`, `matchingConfigurationFields`, `matchingCredentials`, `parseHermesList`, and `valuesEqual`. Keep all functions pure and bounded by the shared contract.

- [x] **Step 4: Write failing modal interaction tests**

Mock `invoke()` and cover initial parallel load, Desktop-token modal rendering, tabs, category navigation, search, field controls, invalid values, discard, save, write-only credential set/remove, loading states, fixed safe errors, and terminal fallback.

```tsx
render(<HermesConfigurationDialog
  open
  version="0.20.0"
  onClose={onClose}
  onOpenSetupTerminal={onOpenSetupTerminal}
  onConfigurationChanged={onConfigurationChanged}
/>);

expect(await screen.findByRole("heading", { name: "Configure Hermes" })).toBeVisible();
fireEvent.change(screen.getByLabelText("Default model"), { target: { value: "anthropic/claude-opus-4.6" } });
fireEvent.click(screen.getByRole("button", { name: "Save Hermes settings" }));
await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
  "runtime:update-hermes-configuration",
  { changes: [{ path: "general.model", value: "anthropic/claude-opus-4.6" }] },
));
```

- [x] **Step 5: Implement the Desktop-native modal**

Use Radix Dialog for focus containment and Desktop `Button`/token variables for appearance. Keep the composition component below 500 lines by extracting field and credential rows. Configuration values live only in component state. Credential input clears immediately after accepted mutation and is never echoed into status copy.

The public props are:

```ts
interface HermesConfigurationDialogProps {
  open: boolean;
  version?: string;
  onClose: () => void;
  onOpenSetupTerminal: () => Promise<void>;
  onConfigurationChanged: () => Promise<void>;
}
```

- [x] **Step 6: Run model and modal tests and verify green**

Run: `flox activate -- bun run test -- tests/desktop/hermes-form-model.test.ts tests/desktop/hermes-configuration-dialog.test.tsx`

Expected: all selected tests PASS.

- [x] **Step 7: Commit the native modal slice**

```bash
git add desktop/src/renderer/src/features/settings/hermes tests/desktop/hermes-form-model.test.ts tests/desktop/hermes-configuration-dialog.test.tsx
git commit -m "feat(desktop): add Hermes configuration modal"
```

---

### Task 4: Refresh, discard confirmation, and settings integration

**Files:**
- Modify: `desktop/src/renderer/src/features/settings/hermes/HermesConfigurationDialog.tsx`
- Modify: `desktop/src/renderer/src/features/settings/sections/AgentRuntimeSettingsCard.tsx`
- Modify: `shell/src/components/settings/sections/HermesConfigurationDialog.tsx`
- Test: `tests/desktop/hermes-configuration-dialog.test.tsx`
- Test: `tests/desktop/agent-section.test.tsx`
- Test: `tests/shell/hermes-configuration.test.tsx`

**Interfaces:**
- Consumes: Task 3 dialog and the existing `openProviderSetupTerminal()` helper.
- Produces: matching explicit Refresh semantics in Shell and Desktop, plus the graphical Desktop Configure entry.

- [x] **Step 1: Add failing Desktop refresh and integration tests**

Cover immediate clean refresh, confirmation before dirty refresh, failed refresh preserving last-good data and draft, duplicate-refresh suppression, close confirmation, runtime-scope unmount clearing state, `Configure Hermes` opening the modal, and fallback opening the canonical setup terminal.

```tsx
fireEvent.change(screen.getByLabelText("Default model"), { target: { value: "local-change" } });
fireEvent.click(screen.getByRole("button", { name: "Refresh Hermes configuration" }));
expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible();
fireEvent.click(screen.getByRole("button", { name: "Discard and refresh" }));
await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("runtime:get-hermes-configuration", {}));
```

- [x] **Step 2: Run Desktop refresh tests and verify red**

Run: `flox activate -- bun run test -- tests/desktop/hermes-configuration-dialog.test.tsx tests/desktop/agent-section.test.tsx`

Expected: FAIL because refresh confirmation and the graphical entry are not wired.

- [x] **Step 3: Implement Desktop refresh and integration**

Use a bounded monotonically increasing request revision so older refreshes cannot overwrite newer state. On refresh failure, keep current configuration, credentials, and drafts. In `AgentRuntimeSettingsCard`, open the graphical modal only for Hermes; retain OpenClaw and graphical-fallback terminal actions. Call the existing `load()` after successful settings or credential mutations.

- [x] **Step 4: Add failing Shell refresh tests**

Assert Shell exposes `Refresh Hermes configuration`, asks before discarding dirty settings, preserves last-good state and drafts when refresh fails, and ignores stale older responses.

- [x] **Step 5: Implement the matching Shell refresh flow**

Extract the existing load effect body into a stable `loadConfiguration({ discardDrafts: boolean })` operation. Add a Refresh button beside the version, an accessible discard confirmation, request revision protection, and non-destructive failure handling. Do not change Shell styling or share Desktop state.

- [x] **Step 6: Run integration regression tests and verify green**

Run: `flox activate -- bun run test -- tests/desktop/hermes-configuration-dialog.test.tsx tests/desktop/agent-section.test.tsx tests/desktop/providers-section.test.tsx tests/shell/hermes-configuration.test.tsx tests/shell/agent-settings.test.tsx`

Expected: all selected tests PASS.

- [x] **Step 7: Commit refresh and integration**

```bash
git add desktop/src/renderer/src/features/settings/hermes/HermesConfigurationDialog.tsx desktop/src/renderer/src/features/settings/sections/AgentRuntimeSettingsCard.tsx shell/src/components/settings/sections/HermesConfigurationDialog.tsx tests/desktop/hermes-configuration-dialog.test.tsx tests/desktop/agent-section.test.tsx tests/shell/hermes-configuration.test.tsx
git commit -m "feat(desktop): align Hermes setup flow"
```

---

### Task 5: Full verification, live Desktop evidence, and handoff

**Files:**
- Modify: `specs/105-coding-agent-shells/desktop-hermes-configuration.md` only if implementation reveals a reviewed design correction
- Modify: `workpad.md` locally; do not commit it
- External follow-up: `FinnaAI/matrix-os-site` public documentation PR

**Interfaces:**
- Consumes: all previous tasks.
- Produces: release-ready validation evidence and one focused Matrix OS PR.

- [ ] **Step 1: Run focused tests**

Run:

```bash
flox activate -- bun run test -- \
  tests/contracts/hermes-configuration.test.ts \
  tests/gateway/hermes-proxy.test.ts \
  tests/shell/hermes-configuration.test.tsx \
  tests/shell/agent-settings.test.tsx \
  tests/desktop/hermes-configuration-client.test.ts \
  tests/desktop/hermes-form-model.test.ts \
  tests/desktop/hermes-configuration-dialog.test.tsx \
  tests/desktop/agent-section.test.tsx \
  tests/desktop/providers-section.test.tsx \
  tests/desktop/ipc-contract.test.ts \
  tests/desktop/ipc-handlers.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 2: Run repository quality gates**

Run:

```bash
flox activate -- bun run typecheck
flox activate -- bun run check:patterns:diff
flox activate -- pnpm exec react-doctor@latest desktop/src/renderer/src shell/src
flox activate -- bun run build:desktop
git diff --check origin/main...HEAD
```

Expected: commands PASS, or pre-existing non-blocking baseline findings are recorded exactly and separated from MAT-262 changes.

- [ ] **Step 3: Run live Electron verification**

Launch `flox activate -- bun run dev:desktop`, sign in to the selected Matrix computer, and verify:

1. `Settings -> Agent -> Configure Hermes` opens the Desktop-native modal.
2. Settings and Credentials match the Shell operation order.
3. Clean Refresh reloads immediately.
4. Dirty Refresh and dirty Close require confirmation.
5. Save, discard, credential set/remove, failure preservation, runtime switch, and terminal fallback behave as specified.
6. Keyboard navigation, Escape handling, focus containment, and Desktop zoom remain usable.

Capture English-labeled Desktop and Shell screenshots for the PR.

- [ ] **Step 4: Sync the existing Linear workpad comment**

Update comment `3c74d75b-3c9e-46e7-b84e-a3171316a949` with implementation status, exact validation, screenshot/PR links, remaining risks, and the separate docs follow-up. Do not create duplicate milestone comments.

- [ ] **Step 5: Prepare the focused PR**

Use a Conventional Commit PR title such as `feat(desktop): align Hermes configuration flow`. Include Summary, Tests, Screenshots, and the mandatory Invariants section covering source of truth, write serialization scope, acceptable orphan states, auth source of truth, and deferred scope. Attach the PR to MAT-262 and request Greptile review; do not merge before 5/5.
