# Provider Usage Remaining Design

**Issue:** MAT-265
**Status:** Implemented and locally verified; preview Gateway rollout pending
**Scope:** Gateway contracts, provider quota adapters, owner-scoped snapshots,
Desktop IPC/state, and the global Desktop usage surface

## 1. Summary

Matrix OS Desktop will expose a provider-neutral **Usage Remaining** surface.
The compact surface follows the coding account relevant to the current Desktop
context and opens a detail popover containing every configured usage source,
quota window, reset time, freshness state, and available credit balance.

The Gateway is the authority for quota retrieval and normalization. Provider
credentials, browser sessions, raw CLI output, account identifiers, and raw
provider errors never cross into the Electron renderer. A remaining value is
shown only when it is provider-reported or arithmetically derived from a limit
and consumption value reported for the same provider window.

This design implements the quota portion of `FR-110`, the reserved
`GET /api/coding-agents/usage` route, the
`coding_agent_provider_quota_snapshots` persistence seam, and the safe
normalization requirement in `GW-112`.

## 2. Goals

1. Give Desktop users one stable place to see remaining coding-provider quota.
2. Normalize heterogeneous provider windows without pretending all providers
   expose the same data.
3. Support multiple quota windows, reset timestamps, and optional credits.
4. Keep the contract headless so Canvas, mobile, CLI, and channel shells can
   consume it later without depending on Electron.
5. Preserve a recent, clearly marked last-known snapshot across transient
   provider failures and Gateway restarts.
6. Make provider capability and data freshness explicit and testable.

## 3. Non-goals

- Estimating subscription remaining from local token or dollar consumption.
- Reclassifying Matrix kernel `/api/usage` as provider quota.
- Reading browser cookies or provider credentials from the renderer.
- Guaranteeing an exact percentage for providers that expose no authoritative
  quota source.
- Building quota history, charts, alerts, or organization-wide aggregation in
  the first release.
- Adding Gemini CLI as a built-in coding-agent provider; the first-release
  provider matrix continues to exclude it.
- Changing provider selection from the usage popover.

## 4. Terminology And Identity

### Agent provider

The executable/runtime that runs a coding conversation, such as `codex`,
`claude`, `pi`, or `opencode`. This remains represented by
`AgentProviderSummary`.

### Usage source

The account or billing surface that owns quota. Examples include a ChatGPT
Codex subscription, an Anthropic subscription, or an OpenRouter credit account.
A usage source may serve one or more agent providers, and one agent provider may
resolve to different usage sources depending on its selected model and account.

### Quota window

A provider-defined interval with a remaining percentage and optional reset
timestamp, such as a five-hour or weekly Codex window. Window identifiers are
opaque normalized IDs; clients render the safe label supplied by the Gateway.

### Accuracy

- `provider_reported`: the provider returned the remaining percentage.
- `provider_derived`: the Gateway calculated remaining from a provider-reported
  used value and limit belonging to the same window.

Local telemetry is intentionally not an accuracy type for remaining quota.

## 5. Contract

The following names describe the intended contract. The implementation MUST use
strict Zod 4 schemas in `@matrix-os/contracts` and the existing bounded safe
display primitives.

```ts
type ProviderUsageState =
  | "available"
  | "stale"
  | "setup_required"
  | "unavailable"
  | "unsupported";

type ProviderUsageAccuracy =
  | "provider_reported"
  | "provider_derived";

interface ProviderUsageWindow {
  id: string;                  // validated opaque identifier
  label: string;               // bounded safe display string
  remainingPercent: number;    // 0 through 100 inclusive
  resetsAt?: string;           // validated ISO timestamp
  windowMinutes?: number;      // bounded positive integer
}

interface ProviderUsageCredits {
  remaining: number;           // finite, non-negative, bounded
  unit: string;                // bounded safe unit, e.g. USD or credits
}

interface ProviderUsageSourceSummary {
  id: string;                  // safe usage-source identifier
  displayName: string;
  linkedAgentProviderIds: string[];
  state: ProviderUsageState;
  accuracy?: ProviderUsageAccuracy;
  windows: ProviderUsageWindow[];
  credits?: ProviderUsageCredits;
  observedAt?: string;
  expiresAt?: string;
  setupActions: SafeSetupAction[];
}

interface ProviderUsageResponse {
  usageSources: ProviderUsageSourceSummary[];
  serverTime: string;
}
```

### Contract bounds

- At most 20 usage sources per response.
- At most 6 linked agent providers per source.
- At most 4 windows per source.
- At most 4 setup actions per source.
- Remaining percentages MUST be finite and within `0..100`.
- Credit values and window durations MUST be finite and explicitly capped.
- Lists use stable deterministic ordering.
- Schemas are strict; unrecognized provider payload fields are not forwarded.
- `available` and `stale` require at least one window or a credit balance.
- `setup_required`, `unavailable`, and `unsupported` MUST NOT contain a current
  remaining percentage.
- `accuracy` is required when a window or credit balance is present and absent
  otherwise.

The contract uses only `remainingPercent`. Provider adapters that receive a
`usedPercent` normalize it once in the Gateway as `100 - usedPercent`; the
renderer does not repeat provider arithmetic.

## 6. Gateway Architecture

### Route

`GET /api/coding-agents/usage` returns `ProviderUsageResponse` for the verified
owner and selected runtime. It follows the same runtime-routing and bearer-auth
rules as the existing coding-agent summary route.

The route validates the optional runtime query at the boundary, applies a
bounded request timeout, maps internal failures to one generic safe error, and
never returns provider names or raw provider error text supplied by an external
process.

### Adapter seam

Usage retrieval is an optional capability at the provider boundary. The exact
implementation may use an optional `getUsageSources` method on
`CodingAgentProviderAdapter` or a dedicated quota-adapter registry keyed by
agent-provider ID. The implementation plan MUST choose the smaller seam after
checking provider lifecycle ownership, but either form must satisfy these
invariants:

- The registry resolves every dependency at registration time.
- Every adapter accepts `principal`, `now`, and `AbortSignal`.
- Every provider probe has a bounded timeout no greater than five seconds.
- Providers are probed concurrently with an overall route deadline no greater
  than ten seconds.
- One provider failure does not fail or delay successful provider results past
  the overall deadline.
- Capability advertisement is truthful: an adapter without a verified
  machine-readable source returns `unsupported`.
- Provider-specific identifiers, subprocess payloads, filesystem paths, and
  credentials remain inside the adapter.

The usage catalog is independent from the execution-provider registry. Gateway
always includes the built-in Claude, Codex, OpenCode, and Pi identities in the
usage catalog, then preserves any additional configured provider identities.
This visibility does not register, enable, or advertise execution support.

If a catalog provider produces no concrete usage source, the Gateway
synthesizes one stable status-only entry linked to that provider. This preserves
the universal provider list while keeping the entry `unsupported`,
`setup_required`, or `unavailable`; it never invents a billing account or
remaining percentage.

### Codex first implementation

The first exact adapter uses the already version-pinned Codex app-server
contract. It reads rate-limit windows and optional credits from
`account/rateLimits/read` and converts provider usage percentages into remaining
percentages. App-server rate-limit notifications invalidate the relevant cache
entry when supported.

The implementation MUST reuse the validated Codex executable and exact version
checks already required by the provider lifecycle. It must fail closed on an
unexpected schema or version rather than parsing loosely.

### Claude implementation gate

Claude support starts with a throwaway, version-pinned spike. It may advertise
`available` only if the installed supported Claude Code version exposes a stable
machine-readable plan-usage source that can be invoked without parsing terminal
presentation text or exposing credentials. Otherwise the source remains
`unsupported` or `setup_required`.

### Pi, OpenCode, and multi-model runners

Pi must not report one synthetic "Pi quota". A future adapter resolves the
selected underlying account/model provider into one or more usage sources. Until
an authoritative account source exists, Pi remains visible with `unsupported`.
OpenCode follows the same rule: its built-in identity stays visible, while exact
remaining values require an authoritative account source for the selected
underlying provider.

## 7. Persistence And Freshness

Successful normalized snapshots are stored in the existing owner-controlled
Postgres lifecycle using Kysely. The additive table stores one current snapshot
per owner, runtime scope, and usage-source ID.

Minimum columns:

- owner/scope identifiers
- usage-source ID
- safe display name
- normalized linked-provider IDs
- normalized windows JSONB
- normalized optional credits JSONB
- accuracy
- observed timestamp
- expiry timestamp
- updated timestamp

The table MUST NOT store raw provider payloads, credentials, cookies, provider
account IDs, filesystem paths, or raw error messages. Upserts use a unique
constraint with `ON CONFLICT`; no check-then-insert flow is permitted.

Freshness policy:

- `fresh`: observed no more than 60 seconds ago.
- `stale`: a fresh probe failed and the last successful snapshot is no more
  than 15 minutes old.
- `expired`: older data is not returned as remaining; the source becomes
  `unavailable` while retaining no window percentages in the response.

Only successful normalized observations replace the last-good snapshot.
Provider failures are logged with internal diagnostic context but are not stored
as provider text or returned to clients.

## 8. Desktop Transport And State

The Electron main process fetches the owner-authorized Gateway route and parses
the strict shared response schema before exposing it through typed IPC. The
renderer does not call provider endpoints directly.

The implementation adds a focused usage client and IPC method rather than
inflating the frequently loaded `RuntimeSummary`. Usage has an independent
freshness lifecycle and can fail without making the coding workspace summary
unavailable.

The Zustand store keeps serializable arrays and primitives only. Selectors do
not allocate fresh collections; selection and sorting live in exported pure
helpers so contract tests and components share one derivation.

### Refresh triggers

- Initial authenticated Desktop load.
- Runtime switch after the new runtime scope has reconciled.
- Default-provider change.
- Foreground refresh every five minutes; no background polling.
- Popover open when the current snapshot is older than 60 seconds.
- Relevant provider turn completion after server-side cache invalidation.
- Explicit manual refresh, guarded by a server-side rate limiter.

Overlapping refreshes coalesce or abort the obsolete request. Results are
discarded if the runtime scope changed while the request was in flight.

## 9. Desktop UX

### Compact sidebar row

The global usage row sits at the bottom of the Desktop sidebar, immediately
above the runtime-computer control. It remains independent of projects because
provider quota is account/runtime scoped.

Expanded examples:

```text
Codex                     72% left
Claude         Usage unavailable
```

Collapsed mode renders the selected source glyph with a compact progress ring.
The accessible name and tooltip include provider, remaining percentage, reset
time, and freshness. The control remains keyboard reachable.

### Compact source selection

1. Use the provider/account source for the active coding-agent conversation.
2. Otherwise use the configured default agent provider's source.
3. When provider selection is automatic, use the same ready-provider resolution
   as the composer.

Within a source, the compact row displays the lowest remaining percentage among
its current windows. It never silently aggregates percentages across accounts.

### Popover

Clicking the row opens a bounded popover containing:

- every configured usage source in stable order;
- all returned quota windows;
- relative reset time, with the absolute timestamp available in detail text;
- optional credits;
- freshness and last-observed time;
- a manual refresh action;
- an existing safe setup action when authentication is required.

Selecting a source inside the popover does not change the default coding
provider. Provider configuration remains in Settings.

### Copy and visual states

- Fresh: `72% left · resets in 2h`
- Stale: `72% left · updated 4m ago`
- Setup: `Sign in to view usage`
- Temporary failure: `Usage temporarily unavailable`
- Unsupported: `Provider does not expose usage`

Remaining above 20% uses the normal accent. Remaining from 10% through 20% uses
warning/amber. Remaining below 10% uses danger/red. Green is not used because
remaining quota is not a success state. Unknown, unsupported, and stale states
must not render a misleading filled progress ring.

The usage row never blocks navigation, thread creation, provider switching, or
runtime switching.

## 10. Security And Failure Handling

- Owner authorization applies to both live probes and persisted snapshots.
- Runtime query values and all provider/source identifiers are validated before
  service calls or persistence.
- All provider and external calls use `AbortSignal` deadlines.
- Raw errors are logged server-side and mapped to bounded generic states.
- No provider or account credential enters Desktop IPC or Zustand state.
- No server-side browser-cookie scraping is introduced.
- In-memory probe/cache maps have explicit size caps, TTL eviction, and shutdown
  cleanup.
- Persistence uses idempotent upserts and the Gateway-owned Kysely lifecycle.
- A malformed provider payload fails only that source and cannot overwrite the
  last-good snapshot.
- Desktop allows only known safe status copy and does not render server error
  strings.

## 11. TDD And Verification

Implementation follows Red -> Green -> Refactor.

### Contract tests

- Accept every valid state and boundary value.
- Reject percentages outside `0..100`, non-finite numbers, excessive lists,
  unsafe labels, invalid timestamps, and state/data contradictions.
- Prove strict schemas drop no unrecognized provider data into clients.

### Gateway tests

- Normalize provider-reported and provider-derived Codex windows.
- Verify version/schema mismatch fails closed.
- Prove provider timeout and failure isolation.
- Prove stale fallback, 15-minute expiry, and last-good preservation.
- Prove owner/runtime isolation and generic client errors.
- Prove idempotent snapshot upserts and no raw payload persistence.
- Prove bounded cache eviction and shutdown cleanup.

### Desktop main/IPC tests

- Validate route, auth, runtime query, timeout, and strict response parsing.
- Reject malformed Gateway responses.
- Reconcile runtime switches and discard obsolete in-flight results.

### Renderer tests

- Select active-thread, default, and automatic usage sources deterministically.
- Select the lowest current window for the compact row.
- Render fresh, stale, setup, unavailable, unsupported, credits, and collapsed
  states.
- Verify keyboard and accessible labeling.
- Verify no usage failure blocks unrelated Desktop operations.

### Runtime verification

- Run focused contract, Gateway, IPC, store, and component tests.
- Run TypeScript checks and the Desktop production build.
- Launch the real Electron Desktop through Flox.
- Verify expanded and collapsed sidebar states, popover behavior, provider
  switching, runtime switching, stale behavior, and a real Codex account window.
- Capture screenshots for the PR and record any unrelated broad-suite failures
  separately from focused validation.

## 12. Rollout

1. Land the shared schemas and fake-adapter contract tests.
2. Land the owner-scoped snapshot repository and guarded Gateway route.
3. Land the exact Codex adapter behind a usage capability flag.
4. Land Desktop IPC, state, and sidebar UI behind the same capability.
5. Verify a real Codex account in Electron before enabling by default.
6. Run the Claude spike separately; advertise Claude usage only after the
   machine-readable contract is proven and pinned.
7. Add multi-model usage sources independently without changing the Desktop
   contract.

## 13. Acceptance Criteria

- Desktop always has one global provider-usage location when the capability is
  enabled.
- Codex displays provider-backed remaining windows and reset times through a
  real Electron run.
- Every built-in provider has a truthful state even when it is not enabled for
  execution or has no remaining percentage; custom configured providers remain
  included without expanding their execution capability.
- Multiple windows display independently and the compact row uses the lowest
  remaining percentage for the selected source.
- Provider errors, timeouts, and malformed payloads never expose secrets or
  break the coding workspace.
- Runtime/provider changes cannot apply stale results from the previous scope.
- No browser cookie, raw CLI payload, provider account ID, or credential reaches
  the renderer or persisted snapshot.
- Focused tests, type checks, production Desktop build, and live Electron
  verification pass before the issue is considered complete.

## 14. References

- [Provider usage remaining research](./provider-usage-remaining-research.md)
- [Coding-agent shell requirements](./SPEC.md)
- [Full workspace backend design](./FULL-WORKSPACE-BACKEND.md)
- [Acceptance tests](./acceptance-tests.md)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [CodexBar provider strategies](https://github.com/steipete/CodexBar/blob/main/docs/providers.md)
- [Claude Code commands](https://code.claude.com/docs/en/commands)
