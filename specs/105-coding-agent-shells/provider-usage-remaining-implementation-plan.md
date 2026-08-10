# Provider Usage Remaining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trusted, provider-neutral Usage Remaining surface to Matrix OS
Desktop, with exact Codex account windows, truthful unsupported states, safe
owner-scoped stale snapshots, and no credential or raw-provider leakage.

**Architecture:** Shared strict contracts define usage sources independently of
coding-agent runners. A Gateway usage service probes optional provider adapter
capabilities, normalizes Codex app-server rate limits, persists last-good
snapshots in owner Postgres, and exposes `GET /api/coding-agents/usage`.
Electron main fetches and validates that route through typed IPC; a focused
renderer store drives a compact sidebar control and detail popover.

**Tech Stack:** Node.js 24+, TypeScript strict ESM, Zod 4 via `zod/v4`, Hono,
Kysely/Postgres, Vitest, React 19, Zustand, Radix Popover, Electron, Flox,
pnpm, Bun.

## Global Constraints

- Follow Red -> Green -> Refactor; no production behavior is added before its
  focused test has failed for the expected reason.
- Use the existing `ProviderIdSchema`, `SafeDisplayStringSchema`,
  `SafeSetupActionSchema`, `IsoTimestampSchema`, and runtime principal boundary.
- Return at most 20 usage sources, 6 linked providers per source, 4 windows per
  source, and 4 setup actions per source.
- `remainingPercent` is finite and within `0..100`; the renderer never derives
  subscription remaining from local tokens or Matrix `/api/usage`.
- Provider probes accept `AbortSignal`, time out within 5 seconds, and are
  bounded by a 10-second route deadline.
- Only normalized last-good snapshots persist in owner Postgres; never persist
  raw provider payloads, credentials, cookies, account IDs, filesystem paths,
  or raw errors.
- Use idempotent `INSERT ... ON CONFLICT ... DO UPDATE`; no check-then-insert.
- Repositories injected with a shared Kysely instance do not destroy it.
- Desktop receives provider usage only through validated main-process IPC.
- Unknown provider errors are logged server-side and reduced to allowlisted
  client states/copy.
- Gemini CLI remains excluded from the built-in first-release provider matrix.
- No new dependency is required; if a dependency changes, run root
  `pnpm install --frozen-lockfile` and preserve `pnpm-lock.yaml` consistency.

---

### Task 1: Shared Provider Usage Contracts And Capability

**Files:**

- Modify: `packages/contracts/src/index.ts`
- Modify: `tests/contracts/coding-agents.test.ts`
- Modify: `tests/contracts/runtime-computers.test.ts`

**Interfaces:**

- Produces `ProviderUsageStateSchema`, `ProviderUsageAccuracySchema`,
  `ProviderUsageWindowSchema`, `ProviderUsageCreditsSchema`,
  `ProviderUsageSourceSummarySchema`, `ProviderUsageResponseSchema`, and their
  inferred types.
- Adds the existing canonical capability ID `codingAgentsUsageSummary` to the
  runtime-summary capability schema; the computer-inventory schema already
  reserves the same ID.
- Later tasks consume `ProviderUsageSourceSummary` and
  `ProviderUsageResponse` without redefining their shape.

- [x] **Step 1: Write failing contract tests**

Add literal fixtures that prove the schema accepts a provider-reported Codex
window and a status-only unsupported Pi source:

```ts
const response = {
  usageSources: [{
    id: "openai-chatgpt",
    displayName: "Codex",
    linkedAgentProviderIds: ["codex"],
    state: "available",
    accuracy: "provider_reported",
    windows: [{
      id: "primary",
      label: "5-hour",
      remainingPercent: 72,
      resetsAt: "2026-08-10T08:00:00.000Z",
      windowMinutes: 300,
    }],
    credits: { remaining: 12.5, unit: "USD" },
    observedAt: "2026-08-10T06:00:00.000Z",
    expiresAt: "2026-08-10T06:01:00.000Z",
    setupActions: [],
  }, {
    id: "pi",
    displayName: "Pi",
    linkedAgentProviderIds: ["pi"],
    state: "unsupported",
    windows: [],
    setupActions: [],
  }],
  serverTime: "2026-08-10T06:00:00.000Z",
};

expect(ProviderUsageResponseSchema.parse(response)).toEqual(response);
expect(RuntimeCapabilityIdSchema.parse("codingAgentsUsageSummary"))
  .toBe("codingAgentsUsageSummary");
```

Add mutation-catching rejects for `remainingPercent: 101`, `NaN`, five
windows, duplicate linked provider IDs, unsafe display text, an `available`
source without windows/credits, an `unsupported` source with windows, and raw
extra fields such as `accessToken` or `providerPayload`.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
flox activate -- pnpm exec vitest run \
  tests/contracts/coding-agents.test.ts \
  tests/contracts/runtime-computers.test.ts
```

Expected: FAIL because the provider usage schemas and capability ID do not
exist.

- [x] **Step 3: Implement the strict schemas**

Add the schemas near `AgentProviderSummarySchema`:

```ts
export const ProviderUsageStateSchema = z.enum([
  "available", "stale", "setup_required", "unavailable", "unsupported",
]);
export const ProviderUsageAccuracySchema = z.enum([
  "provider_reported", "provider_derived",
]);
export const ProviderUsageWindowSchema = z.object({
  id: z.string().min(1).max(80).regex(SAFE_SLUG),
  label: SafeDisplayStringSchema,
  remainingPercent: z.number().finite().min(0).max(100),
  resetsAt: IsoTimestampSchema.optional(),
  windowMinutes: z.number().int().min(1).max(525_600).optional(),
}).strict();
export const ProviderUsageCreditsSchema = z.object({
  remaining: z.number().finite().min(0).max(1_000_000_000),
  unit: z.string().min(1).max(24).regex(/^[A-Za-z][A-Za-z0-9._-]{0,23}$/),
}).strict();
```

Define `ProviderUsageSourceSummarySchema` with the approved state/data
refinements, duplicate-provider rejection, bounded lists, and strict output.
Define `ProviderUsageResponseSchema` with 20 sources and `serverTime`. Export
all inferred types and add `codingAgentsUsageSummary` to
`RuntimeCapabilityIdSchema`.

- [x] **Step 4: Run tests and verify GREEN**

Run the command from Step 2. Expected: both files PASS with no warnings.

- [x] **Step 5: Commit the contract slice**

```bash
git add packages/contracts/src/index.ts \
  tests/contracts/coding-agents.test.ts \
  tests/contracts/runtime-computers.test.ts
git commit -m "feat(contracts): add provider usage summaries"
```

---

### Task 2: Owner-Scoped Postgres Snapshot Repository

**Files:**

- Create: `packages/gateway/src/coding-agents/provider-usage-repository.ts`
- Create: `tests/gateway/coding-agents-provider-usage-repository.test.ts`

**Interfaces:**

- Consumes `ProviderUsageSourceSummary` from Task 1.
- Produces `CodingAgentProviderUsageSnapshotRepository` with:

```ts
bootstrap(): Promise<void>;
upsert(input: {
  ownerId: string;
  runtimeId: string;
  source: ProviderUsageSourceSummary;
}): Promise<void>;
list(input: {
  ownerId: string;
  runtimeId: string;
}): Promise<ProviderUsageSourceSummary[]>;
```

- The constructor accepts `Dialect | Kysely<ProviderUsageDatabase>` and follows
  existing shared-resource ownership semantics.

- [x] **Step 1: Write failing PGlite repository tests**

Using `KyselyPGlite.create()`, prove:

1. `bootstrap()` is idempotent.
2. `upsert()` stores and returns a normalized available Codex snapshot.
3. A second upsert replaces the same owner/runtime/source row rather than
   inserting another row.
4. Identical source IDs remain isolated across owner and runtime values.
5. JSON contains no fields beyond the shared source contract.
6. `destroy()` does not close an injected shared Kysely instance.

- [x] **Step 2: Run the repository test and verify RED**

```bash
flox activate -- pnpm exec vitest run \
  tests/gateway/coding-agents-provider-usage-repository.test.ts
```

Expected: FAIL because the repository module does not exist.

- [x] **Step 3: Implement bootstrap, upsert, and list**

Create `coding_agent_provider_quota_snapshots` with a composite primary key on
`owner_id`, `runtime_id`, and `source_id`; JSONB columns hold only
`linked_agent_provider_ids`, `windows`, `credits`, and `setup_actions`.

Use one atomic upsert:

```ts
await this.kysely
  .insertInto("coding_agent_provider_quota_snapshots")
  .values(values)
  .onConflict((oc) => oc
    .columns(["owner_id", "runtime_id", "source_id"])
    .doUpdateSet({
      display_name: values.display_name,
      linked_agent_provider_ids: values.linked_agent_provider_ids,
      state: values.state,
      accuracy: values.accuracy,
      windows: values.windows,
      credits: values.credits,
      observed_at: values.observed_at,
      expires_at: values.expires_at,
      setup_actions: values.setup_actions,
      updated_at: values.updated_at,
    }))
  .execute();
```

Parse every selected row back through `ProviderUsageSourceSummarySchema`.
Only destroy Kysely when the repository constructed it from a dialect.

- [x] **Step 4: Run the repository test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [x] **Step 5: Commit the repository slice**

```bash
git add packages/gateway/src/coding-agents/provider-usage-repository.ts \
  tests/gateway/coding-agents-provider-usage-repository.test.ts
git commit -m "feat(gateway): persist provider usage snapshots"
```

---

### Task 3: Provider Usage Service, Adapter Capability, And Route

**Files:**

- Modify: `packages/gateway/src/coding-agents/provider-adapter.ts`
- Create: `packages/gateway/src/coding-agents/provider-usage.ts`
- Modify: `packages/gateway/src/coding-agents/routes.ts`
- Modify: `packages/gateway/src/coding-agents/runtime-summary.ts`
- Create: `tests/gateway/coding-agents-provider-usage.test.ts`
- Modify: `tests/gateway/coding-agents-summary.test.ts`

**Interfaces:**

- Extends `CodingAgentProviderAdapter` with optional:

```ts
getUsageSources?(input: {
  principal: RequestPrincipal;
  now: () => Date;
  signal: AbortSignal;
}): Promise<ProviderUsageSourceSummary[]> | ProviderUsageSourceSummary[];
```

- Produces `CodingAgentProviderUsageService`:

```ts
getUsage(
  principal: RequestPrincipal,
  options?: { forceRefresh?: boolean },
): Promise<ProviderUsageResponse>;
close(): void;
```

- `createCodingAgentProviderUsageService` consumes the registered provider
  adapters, provider summaries, optional snapshot repository, `runtimeId`, and
  injected clock/timeouts for tests.

- [x] **Step 1: Write failing service and route tests**

Use real service behavior with small fake provider adapters to prove:

1. Successful sources normalize through the shared contract.
2. Providers without `getUsageSources` receive stable status-only
   `unsupported` entries.
3. Auth/setup provider summaries produce `setup_required` entries with bounded
   setup actions.
4. A failing provider does not remove a successful provider.
5. A recent persisted last-good source returns as `stale` after probe failure.
6. A snapshot older than 15 minutes returns `unavailable` with no windows.
7. More than 20 providers are capped and stable-sorted.
8. `GET /api/coding-agents/usage` requires a principal, returns strict JSON,
   and maps internal failures to `usage_unavailable` without raw text.
9. Runtime summary advertises `codingAgentsUsageSummary` only when configured.
10. `refresh=1` bypasses fresh cache only while a capped owner-scoped rate
    limiter allows it; invalid query values fail validation.
11. `close()` clears timers and cached entries.

- [x] **Step 2: Run focused tests and verify RED**

```bash
flox activate -- pnpm exec vitest run \
  tests/gateway/coding-agents-provider-usage.test.ts \
  tests/gateway/coding-agents-summary.test.ts
```

Expected: FAIL because the service, adapter method, route, and capability do not
exist.

- [x] **Step 3: Implement minimal service behavior**

Create a capped TTL cache keyed by owner/runtime/provider. Probe adapters in
parallel, give each an `AbortSignal.timeout(providerTimeoutMs)`, enforce the
overall deadline, and validate successful output immediately. Synthesize
status-only entries from registered `AgentProviderSummary` values when no exact
source exists.

Persist only `available` sources. On failure, load repository snapshots and map
them to `stale` when age is at most 15 minutes; otherwise emit `unavailable`
without windows, credits, accuracy, observed, or expiry data. Never reuse a
snapshot belonging to another owner/runtime.

Add the route only when `deps.usage` exists. Validate an optional single
`refresh=1` query value at the route boundary:

```ts
app.get("/usage", async (c) => {
  try {
    const query = UsageQuerySchema.parse({ refresh: c.req.query("refresh") });
    return c.json(await deps.usage!.getUsage(principalFor(c), {
      forceRefresh: query.refresh === "1",
    }));
  } catch (error: unknown) {
    // principal errors preserve their mapped status; all other errors are
    // logged internally and return one generic safe 503 envelope.
  }
});
```

Use the existing capped `createRateLimiter` with an owner/runtime key for forced
refresh. A rejected force request returns current cached/last-good data rather
than a raw limiter error or a new provider probe.

Add `providerUsage?: boolean` to runtime summary capabilities and emit the new
capability entry when configured.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [x] **Step 5: Commit the service slice**

```bash
git add packages/gateway/src/coding-agents/provider-adapter.ts \
  packages/gateway/src/coding-agents/provider-usage.ts \
  packages/gateway/src/coding-agents/routes.ts \
  packages/gateway/src/coding-agents/runtime-summary.ts \
  tests/gateway/coding-agents-provider-usage.test.ts \
  tests/gateway/coding-agents-summary.test.ts
git commit -m "feat(gateway): expose normalized provider usage"
```

---

### Task 4: Exact Codex App-Server Usage Probe

**Files:**

- Create: `packages/gateway/src/coding-agents/codex-usage-probe.ts`
- Modify: `packages/gateway/src/coding-agents/workspace-provider.ts`
- Create: `tests/gateway/coding-agents-codex-usage.test.ts`
- Modify: `tests/gateway/coding-agents-workspace-provider.test.ts`

**Interfaces:**

- Produces:

```ts
normalizeCodexRateLimits(
  raw: unknown,
  observedAt: Date,
): ProviderUsageSourceSummary;

createCodexUsageProbe(options: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  readRateLimits?: (signal: AbortSignal) => Promise<unknown>;
}): (input: { signal: AbortSignal; now: () => Date }) =>
  Promise<ProviderUsageSourceSummary[]>;
```

- `WorkspaceCodingAgentProviderOptions` accepts an optional Codex usage probe
  and exposes it only on the Codex adapter.

- [x] **Step 1: Write failing normalization and transport tests**

Use a hand-written current app-server fixture:

```ts
{
  rateLimits: {
    limitId: "codex",
    limitName: "Codex",
    primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1786348800 },
    secondary: { usedPercent: 59, windowDurationMins: 10080, resetsAt: 1786752000 },
    credits: { hasCredits: true, unlimited: false, balance: "12.50" },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
}
```

Assert literal remaining values `72` and `41`, second-to-ISO reset conversion,
window labels, USD credits, and strict rejection of negative/over-100
percentages, invalid decimal balances, unsafe limit labels, and malformed
responses.

Use a temporary executable fixture for the default transport. It reads JSONL,
returns valid results for `initialize` and `account/rateLimits/read`, and records
that `initialized` was sent. Prove the real transport kills the child on abort,
caps provider output, and never includes stderr text in its thrown public error.

- [x] **Step 2: Run focused Codex tests and verify RED**

```bash
flox activate -- pnpm exec vitest run \
  tests/gateway/coding-agents-codex-usage.test.ts \
  tests/gateway/coding-agents-workspace-provider.test.ts
```

Expected: FAIL because the probe and provider usage wiring do not exist.

- [x] **Step 3: Implement the one-shot JSON-RPC reader and normalizer**

Validate the executable with `CodexExecutableSchema`, run its exact installed
version through `codexAppServerContractStatus`, then spawn
`command app-server --stdio`. Send:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"matrix-os","title":"Matrix OS","version":"1"},"capabilities":{"experimentalApi":true}}}
{"method":"initialized","params":{}}
{"id":2,"method":"account/rateLimits/read"}
```

Accept only bounded JSONL responses with matching IDs, terminate after result
2, and kill on timeout/abort. Parse the exact verified schema with Zod before
normalizing. Convert `usedPercent` once as `100 - usedPercent`; convert reset
epoch seconds to ISO. Ignore provider account identifiers and plan labels that
are not needed for the approved display contract.

Pass the probe through `createWorkspaceCodingAgentProviderSet` only for the
Codex registry/execution adapter.

- [x] **Step 4: Run focused Codex tests and verify GREEN**

Execution note: all 9 Codex usage tests and the new Workspace usage wiring
test pass. The full Workspace provider file remains 14/15 because its existing
interactive Bash handoff test selects the host zsh on this macOS/Flox runtime
and times out after 20 seconds; that test has no overlap with this slice.

Run the command from Step 2. Expected: PASS.

- [x] **Step 5: Commit the Codex slice**

```bash
git add packages/gateway/src/coding-agents/codex-usage-probe.ts \
  packages/gateway/src/coding-agents/workspace-provider.ts \
  tests/gateway/coding-agents-codex-usage.test.ts \
  tests/gateway/coding-agents-workspace-provider.test.ts
git commit -m "feat(gateway): read Codex account quota"
```

---

### Task 5: Gateway Production Wiring And Lifecycle

**Files:**

- Modify: `packages/gateway/src/server.ts`
- Modify: `packages/gateway/src/index.ts`
- Create: `packages/gateway/src/coding-agents/provider-usage-wiring.ts`
- Create: `tests/gateway/coding-agents-provider-usage-wiring.test.ts`

**Interfaces:**

- Consumes the repository, usage service, and Codex probe from Tasks 2-4.
- Wires `usage` into `createCodingAgentRoutes` and
  `providerUsage: true` into runtime summary only when the service is ready.
- Reuses the server-owned Kysely lifecycle and closes only the service-owned
  cache/timers during Gateway shutdown.

- [x] **Step 1: Write failing wiring tests**

Exercise an exported focused factory rather than grep source text. Inject a
shared Kysely/PGlite database, Codex probe fake, provider adapters, and clock;
assert it bootstraps the repository, returns usage, and leaves shared Kysely
usable after service close. Assert no service is created when Postgres is
unavailable, so misconfiguration becomes a disabled capability rather than a
fake empty success.

- [x] **Step 2: Run the wiring test and verify RED**

```bash
flox activate -- pnpm exec vitest run \
  tests/gateway/coding-agents-provider-usage-wiring.test.ts
```

Expected: FAIL because production wiring is absent.

- [x] **Step 3: Implement wiring after Postgres bootstrap**

Create the Codex usage probe from the resolved executable before constructing
the provider set, because provider adapters are registered before database
bootstrap. After `kyselyInstance` is available, construct and bootstrap the
quota repository and create the usage service over those already-registered
adapters. Pass the optional service into the coding-agent routes. A missing
database disables the capability instead of masquerading as provider not-found.

Register `usageService.close()` in the Gateway shutdown path before destroying
the shared Kysely instance. Export only the focused factory/types needed by
tests and downstream packages.

- [x] **Step 4: Run wiring and regression tests and verify GREEN**

```bash
flox activate -- pnpm exec vitest run \
  tests/gateway/coding-agents-provider-usage-wiring.test.ts \
  tests/gateway/coding-agents-summary.test.ts \
  tests/gateway/coding-agents-workspace-provider.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit the wiring slice**

```bash
git add packages/gateway/src/server.ts packages/gateway/src/index.ts \
  tests/gateway/coding-agents-provider-usage-wiring.test.ts
git commit -m "feat(gateway): wire provider usage lifecycle"
```

---

### Task 6: Desktop Main Client And Typed IPC

**Files:**

- Modify: `desktop/src/main/coding-agents/runtime-summary-client.ts`
- Modify: `desktop/src/shared/ipc-contract.ts`
- Modify: `desktop/src/main/ipc/handlers.ts`
- Modify: `desktop/src/main/index.ts`
- Modify: `tests/desktop/coding-agent-runtime-client.test.ts`
- Modify: `tests/desktop/ipc-contract.test.ts`
- Modify: `tests/desktop/ipc-handlers.test.ts`

**Interfaces:**

- Produces `fetchCodingAgentProviderUsage(auth, options?, fetchFn?)` returning
  `ProviderUsageResponse`, where `options.forceRefresh` adds the validated
  `refresh=1` query.
- Adds IPC channel `runtime:get-provider-usage` with strict
  `{ forceRefresh?: boolean }` request and strict `ProviderUsageResponseSchema`
  response.

- [x] **Step 1: Write failing main/IPC tests**

Prove the main client requests
`/api/coding-agents/usage?runtime=secondary`, sends bearer auth, uses an
`AbortSignal`, parses a valid response, and rejects a response containing
`accessToken`, raw provider errors, invalid percentages, or non-2xx status with
only `provider usage unavailable`.

Prove `{ forceRefresh: true }` adds `refresh=1`, while the default request does
not add it.

Prove the IPC channel rejects request credential fields, validates the response,
calls `fetchProviderUsage` once, and maps raw thrown errors to `internal error`.

- [x] **Step 2: Run focused Desktop main tests and verify RED**

```bash
flox activate -- pnpm exec vitest run \
  tests/desktop/coding-agent-runtime-client.test.ts \
  tests/desktop/ipc-contract.test.ts \
  tests/desktop/ipc-handlers.test.ts
```

Expected: FAIL because the client and IPC channel do not exist.

- [x] **Step 3: Implement the client and IPC bridge**

Add a 10-second timeout constant and follow `buildRuntimeUrl`:

```ts
export async function fetchCodingAgentProviderUsage(
  auth: AuthService,
  options: { forceRefresh?: boolean } = {},
  fetchFn: FetchFn = fetch,
): Promise<ProviderUsageResponse> {
  const token = auth.getToken();
  if (!token) throw new Error("provider usage unavailable");
  const url = buildRuntimeUrl(auth, "/api/coding-agents/usage");
  if (options.forceRefresh) url.searchParams.set("refresh", "1");
  const response = await fetchFn(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(PROVIDER_USAGE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("provider usage unavailable");
  const parsed = ProviderUsageResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("provider usage unavailable");
  return parsed.data;
}
```

Wire the function through `HandlerContext`, handler registration, and Desktop
main composition exactly like runtime summary, without exposing the auth token
to preload/renderer.

- [x] **Step 4: Run focused main tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [x] **Step 5: Commit the Desktop transport slice**

```bash
git add desktop/src/main/coding-agents/runtime-summary-client.ts \
  desktop/src/shared/ipc-contract.ts desktop/src/main/ipc/handlers.ts \
  desktop/src/main/index.ts \
  tests/desktop/coding-agent-runtime-client.test.ts \
  tests/desktop/ipc-contract.test.ts tests/desktop/ipc-handlers.test.ts
git commit -m "feat(desktop): bridge provider usage through IPC"
```

---

### Task 7: Serializable Desktop Usage Store And Selection Helpers

**Files:**

- Create: `desktop/src/renderer/src/stores/provider-usage.ts`
- Create: `tests/desktop/provider-usage-store.test.ts`

**Interfaces:**

- Produces `useProviderUsage` with serializable state:

```ts
type ProviderUsageStatus = "idle" | "loading" | "ready" | "refreshing" | "error";

interface ProviderUsageState {
  status: ProviderUsageStatus;
  response: ProviderUsageResponse | null;
  runtimeScope: string | null;
  error: string | null;
  ensureRuntimeScope(scope: string): void;
  refresh(options?: { force?: boolean }): Promise<void>;
  clear(): void;
}
```

- Exports pure helpers:
  `selectUsageSource(response, summary, activeThreadId, defaultProviderId)` and
  `lowestRemainingWindow(source)`.

- [x] **Step 1: Write failing store/helper tests**

Prove with complete literal fixtures:

1. Active thread provider wins over the configured default.
2. Default provider is used without an active coding thread.
3. Automatic selection matches the first ready provider.
4. An ambiguous/missing source does not borrow another account's percentage.
5. The lowest remaining window is selected literally (`41`, not `72`).
6. Runtime scope changes clear prior owner data and discard an obsolete in-flight
   result.
7. Concurrent refresh calls coalesce.
8. A failed refresh keeps last-good renderer data but sets allowlisted copy.
9. Data older than 60 seconds refreshes on demand; fresh data does not refetch
   unless forced.

- [x] **Step 2: Run the store test and verify RED**

```bash
flox activate -- pnpm exec vitest run \
  tests/desktop/provider-usage-store.test.ts
```

Expected: FAIL because the store and helpers do not exist.

- [x] **Step 3: Implement minimal serializable state and helpers**

Use `invoke("runtime:get-provider-usage", {
forceRefresh: options.force === true })`, runtime-generation guards, one
module-level in-flight promise, and primitive sequence/scope checks. Keep the
generic renderer error exactly `Provider usage is temporarily unavailable.`.
Do not store `Date`, `Map`, `Set`, `AbortController`, or Error objects in
Zustand.

Source selection reads stable store slices and performs derivation in exported
pure functions. It never allocates inside a Zustand selector.

- [x] **Step 4: Run the store test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [x] **Step 5: Commit the store slice**

```bash
git add desktop/src/renderer/src/stores/provider-usage.ts \
  tests/desktop/provider-usage-store.test.ts
git commit -m "feat(desktop): manage provider usage state"
```

---

### Task 8: Sidebar Usage Control And Detail Popover

**Files:**

- Create: `desktop/src/renderer/src/features/mission-control/ProviderUsageMenu.tsx`
- Modify: `desktop/src/renderer/src/features/mission-control/Sidebar.tsx`
- Modify: `desktop/src/renderer/src/features/mission-control/MissionControl.tsx`
- Modify: `desktop/src/renderer/src/features/coding-agents/provider-setup-terminal.ts`
- Create: `tests/desktop/provider-usage-menu.test.tsx`
- Modify: `tests/desktop/mission-control.test.tsx`

**Interfaces:**

- `ProviderUsageMenu({ collapsed }: { collapsed: boolean })` owns only
  presentation and refresh/setup event wiring; data remains in Task 7's store.
- Reuses Radix Popover, existing design tokens, provider glyphs, runtime summary,
  provider preferences, tabs, and safe foreground-terminal setup behavior.

- [x] **Step 1: Write failing component tests**

Using the real component and stores, prove:

1. Expanded sidebar renders `Codex` and `72% left`.
2. The compact row chooses `41% left` when the weekly window is more constrained.
3. Clicking opens a dialog-like popover listing both windows, reset copy,
   credits, freshness, and all provider sources.
4. Collapsed mode has an accessible label containing provider, remaining, reset,
   and freshness without rendering the expanded text.
5. Warning and danger states use the approved token colors at 20% and 9%.
6. Unsupported, setup-required, unavailable, stale, loading, and total-failure
   states use allowlisted copy and never show a made-up progress value.
7. Manual refresh calls the store with `{ force: true }`.
8. Setup action opens the existing visible terminal flow.
9. Popover interaction does not change the default provider.
10. The row is immediately above the runtime-computer menu in the Sidebar.

- [x] **Step 2: Run focused component tests and verify RED**

```bash
flox activate -- pnpm exec vitest run \
  tests/desktop/provider-usage-menu.test.tsx \
  tests/desktop/mission-control.test.tsx
```

Expected: FAIL because the UI is absent.

- [x] **Step 3: Implement the compact row, ring, and popover**

Use `@radix-ui/react-popover` for focus, dismissal, and portal behavior. The
expanded row renders provider, status, and remaining; collapsed mode renders a
small SVG progress ring only for fresh known values. Stale or locally retained
last-known values remain textual and use the neutral usage glyph. The SVG uses
`role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax="100"`, and the exact
remaining value.

Render the popover above the trigger with a bounded width and scroll height.
Relative reset text uses `serverTime` as the stable comparison base; absolute
timestamps remain available in the detail text/title. Use accent above 20%,
warning from 10% through 20%, and danger below 10%.

In `MissionControl`, initialize the store for the authenticated runtime scope,
refresh every five minutes only while `document.visibilityState === "visible"`,
refresh on visible foreground transition when stale, and clear on sign-out.
Opening the popover refreshes when older than 60 seconds.

- [x] **Step 4: Run focused component tests and verify GREEN**

Run the command from Step 2. Expected: PASS with no React warnings.

- [x] **Step 5: Commit the UI slice**

```bash
git add desktop/src/renderer/src/features/mission-control/ProviderUsageMenu.tsx \
  desktop/src/renderer/src/features/mission-control/Sidebar.tsx \
  desktop/src/renderer/src/features/mission-control/MissionControl.tsx \
  desktop/src/renderer/src/features/coding-agents/provider-setup-terminal.ts \
  tests/desktop/provider-usage-menu.test.tsx \
  tests/desktop/mission-control.test.tsx
git commit -m "feat(desktop): show provider usage remaining"
```

---

### Task 9: Documentation, Focused Regression, Build, And Live Electron Proof

**Files:**

- Modify: `specs/105-coding-agent-shells/provider-usage-remaining-design.md`
- Modify: `specs/105-coding-agent-shells/current-state.md`
- Modify: `specs/105-coding-agent-shells/provider-usage-remaining-implementation-plan.md`

**Interfaces:**

- Records exact implementation choices, test commands, real provider coverage,
  and any intentionally deferred Claude/Pi adapter work.

- [x] **Step 1: Mark executed plan steps and document current state**

Update this plan's checkboxes as each step completes. Change the design status
only after implementation verification. Add an English current-state entry
describing the route, contract, Codex source, Desktop UI, and truthful fallback
states; do not claim Claude/Pi exact remaining unless their adapters exist.

- [x] **Step 2: Run the complete focused regression**

```bash
flox activate -- pnpm exec vitest run \
  tests/contracts/coding-agents.test.ts \
  tests/contracts/runtime-computers.test.ts \
  tests/gateway/coding-agents-provider-usage-repository.test.ts \
  tests/gateway/coding-agents-provider-usage.test.ts \
  tests/gateway/coding-agents-codex-usage.test.ts \
  tests/gateway/coding-agents-provider-usage-wiring.test.ts \
  tests/gateway/coding-agents-workspace-provider.test.ts \
  tests/gateway/coding-agents-summary.test.ts \
  tests/desktop/coding-agent-runtime-client.test.ts \
  tests/desktop/ipc-contract.test.ts \
  tests/desktop/ipc-handlers.test.ts \
  tests/desktop/provider-usage-store.test.ts \
  tests/desktop/provider-usage-menu.test.tsx \
  tests/desktop/mission-control.test.tsx
```

Expected: all focused files PASS with clean output.

- [x] **Step 3: Run static checks and production build**

```bash
flox activate -- bun run typecheck
flox activate -- bun run build:desktop
```

Expected: both commands exit 0. Categorize unrelated broad failures separately;
do not reinterpret them as focused MAT-265 failures.

- [x] **Step 4: Run live Electron verification**

Launch the exact worktree build with the repository's Desktop launch workflow.
Verify the process path, worktree, commit, remote-debug port, Gateway bundle,
and selected runtime before inspecting behavior. Use Playwright over Electron
CDP to verify:

- expanded and collapsed sidebar usage states;
- detail popover and keyboard behavior;
- default-provider and active-thread selection;
- runtime switch clearing/reload;
- stale/unavailable fixtures;
- a real Codex remaining window when the runtime has the exact verified Codex
  version and authenticated account.

Capture screenshots for PR evidence. If the local ChatGPT-bundled Codex version
does not match the repository's exact verified contract, record the exact
version mismatch and use the pinned runtime/fake-process test as evidence rather
than weakening version validation.

Execution record (2026-08-10):

- The complete focused regression passed 15/15 files and 261/261 tests. The
  generated-Bash fixture now isolates its PATH so macOS cannot accidentally
  choose host zsh while testing the Bash fallback.
- `flox activate -- bun run typecheck` and
  `flox activate -- bun run build:desktop` exited 0. The build retained the
  pre-existing MarkdownPreview dynamic/static import chunk warning.
- The production Electron process was verified at commit `79c9295760` from
  this manual worktree with CDP on `127.0.0.1:9222`; its renderer `--app-path`
  resolved to this worktree's `desktop` directory.
- The authenticated real Desktop selected `Preview Computer (pr-1174)`. Its
  deployed runtime summary does not yet advertise
  `codingAgentsUsageSummary`, so the Usage control correctly remained hidden.
- `tests/e2e/desktop/provider-usage.e2e.test.ts` passed 2/2 against the built
  Electron app and strict local stub Gateway. It proved expanded/collapsed
  states, popover content, keyboard open/Escape close, force refresh, placement
  above the computer menu, credits, unsupported Pi, and stale/unavailable
  truthfulness. Screenshots are under `output/playwright/mat-265-usage-*.png`.
- The installed ChatGPT-bundled Codex reports `0.147.0-alpha.6.5`; the
  repository contract is pinned to `0.146.0`. A real account percentage was
  therefore not claimed, and the version guard was not weakened. The exact
  app-server transport remains covered by nine fake-process tests.
- Remaining rollout evidence: deploy a MAT-265 Gateway bundle to a disposable
  preview computer with the pinned Codex version, then capture the real-account
  window before enabling the capability broadly. Publish the user-facing usage
  documentation through a separate `FinnaAI/matrix-os-site` PR at that rollout
  boundary so public docs never advertise an unavailable capability.

- [x] **Step 5: Run final hygiene checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only MAT-265 files are changed.

- [x] **Step 6: Commit the documentation and verification record**

```bash
git add specs/105-coding-agent-shells/provider-usage-remaining-design.md \
  specs/105-coding-agent-shells/provider-usage-remaining-research.md \
  specs/105-coding-agent-shells/provider-usage-remaining-implementation-plan.md \
  specs/105-coding-agent-shells/current-state.md
git commit -m "docs(coding-agents): document provider usage remaining"
```

---

## Self-Review Record

### Spec coverage

- Contract bounds and state/data truthfulness: Task 1.
- Owner-Postgres last-good snapshots and idempotent upsert: Task 2.
- Optional adapter capability, failure isolation, stale/expiry policy, and safe
  route: Task 3.
- Exact version-pinned Codex rate-limit source: Task 4.
- Production database/provider/server lifecycle: Task 5.
- Trusted Desktop transport: Task 6.
- Serializable scope-safe client state and account selection: Task 7.
- Compact/sidebar/popover/accessibility/setup UX: Task 8.
- Full verification and honest provider coverage documentation: Task 9.

No approved requirement is left without an implementation or verification
task. Claude exact usage remains intentionally gated on a separate
machine-readable spike, as required by the approved design.

### Placeholder scan

The plan contains no unresolved placeholder, generic error-handling instruction,
or task that delegates unspecified tests. Every behavior
step names the observable break it protects and supplies exact interfaces,
fixtures, commands, and output expectations.

### Type consistency

All later tasks consume the Task 1 names `ProviderUsageSourceSummary` and
`ProviderUsageResponse`. The adapter method is consistently
`getUsageSources`; the Gateway service is consistently `getUsage`; the Desktop
client is `fetchCodingAgentProviderUsage`; the IPC channel is consistently
`runtime:get-provider-usage`; and the renderer store is consistently
`useProviderUsage`.
