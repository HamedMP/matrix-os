# Agents & Providers Settings

Status: reconstructed implementation; final combined exact-head acceptance remains pending. Historical fixture receipts are not current acceptance.

## Product behavior

Settings presents Matrix AI first, Coding agents (Claude Code, Codex, OpenCode, Pi) second, and General agents (Hermes, OpenClaw) third. Each agent has one truthful status and an accessible accordion. Additional configured instances remain visible. Account dependencies, route selection, budgets and allowlists survive through advanced controls. The 2026-10-02 human review removes the visible Enable switch and local-login/unverified row labels; explicit successful Connect enables the exact agent, while refresh retains owner configuration.

The visual reference is [Settings canvas 1112:2178](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1112-2178). Overview, connected account and method chooser were read through Figma design context; the remaining device login, key validation, install and disconnect frames were inspected through user-authorized computer use. Sample balances, models, account identifiers, percentages and countdowns are not product data.

| Control | Authority and outcome |
| --- | --- |
| Refresh | Re-read current owner/computer capabilities and canonical provider snapshot |
| Matrix AI balance/models | Authoritative spendable ledger balance and policy-authorized display-only model inventory |
| Usage history | Bounded owner/computer ledger projection; unknown model stays unknown |
| Buy credit | Existing scoped, idempotent credit checkout; no automatic payment |
| Connect / Change account / Reconnect | Explicit supported native login or validated key submission |
| Device code / Copy / sign-in / Cancel | Foreground expiring operation; allowlisted URL and actual cancellation |
| Key Connect / retry / Back | Transient masked input; validate before saving, retain prior credential on failure |
| Install / Cancel | Fixed managed harness executable operation, real phase and canonical Terminal visibility |
| View logs | Only when advertised; bounded sanitized operation evidence, never arbitrary native output or secrets |
| Disconnect | Disable only the selected Matrix agent; preserve native credentials, other agents and owner data |
| Also uninstall | Separately authorized managed executable removal, never saved instance removal or home deletion |

## Architecture and compatibility

ProviderSettingsSnapshot and canonical V3 remain the source of provider/access truth. Shared @matrix-os/ui owns presentation derivation; Web Canvas, Web Desktop and Electron Desktop consume the same component and typed operations. Renderer adapters own navigation and abortable runtime-bound transport. New workflow and history contracts are separate from historical strict snapshots and mutation receipts; capabilities are advertised only when dependencies exist at registration.

Native credential stores remain native. Secrets do not enter snapshots, generic mutation history, public logs or durable operation receipts. No automatic account migration, reassignment, enablement or changes to immutable existing Chat bindings. Unknown allowance and installation progress are shown honestly. Subscription allowance bars show remaining capacity: 100% used is empty, 0% used is full, and partial usage subtracts from the full bar. Keep authoritative used/reset text; accessible meter names and values describe remaining allowance. Missing allowance has no meter. Related durable writes follow existing serialized revision guards or Kysely transactions; no new embedded database.

One injected native-profile guard coordinates canonical and legacy login/logout, key verification/save, and managed install/uninstall for Claude and Codex. Admission checks persisted receipts and live canonical Terminal incarnations, including receipt-evicted sessions; an expired receipt alone cannot release a live process. Exact idempotent recovery may resume its own operation. A lease releases only after confirmed exit/reaping, and ambiguous launch or failed cleanup retains protection. Direct owner Terminal commands remain outside API serialization; fresh credential fingerprints and readback establish observed current authentication mode rather than a universal filesystem lock.

Authorized workflow capabilities may expose an active operation ID for the exact harness. A fresh Settings view retrieves that scoped receipt to restore status and cancellation. Renderer GET requests have a 15-second deadline and mutations a 90-second deadline, independent of the native operation lifetime. An uncertain start retry retains its idempotency key; a lost key-save response reports uncertainty instead of claiming rejection or successful replacement.

Canonical model capabilities are returned only when the caller explicitly requests `includeModelCapabilities=true`, including action responses. Historical strict clients keep their previous model shape. Capability badges display supplied Tools, Vision, Reasoning, Long context or Audio metadata; discovered models with no authoritative capability metadata have no invented badge.

Supported native login stays in Settings: Codex device authorization, Claude browser authorization with a transient paste-code callback, Hermes explicit reuse of its runtime’s Codex account, and capability-discovered OpenCode/Pi methods, and version-gated OpenClaw OpenAI API-key entry. OpenClaw OAuth is unavailable because its verified native command requires a TTY. Native helpers save credentials through their sanctioned runtime interfaces. Unsupported installed versions expose unavailable methods. A configured connection is presented separately from execution readiness. Only a successful explicit connection enables the exact scoped route; refresh never enables it.

The native workflow has a ten-minute deadline. Hermes/OpenClaw install cancellation stops the fixed systemd cgroup, terminates the exact Terminal incarnation, then stops the cgroup again to cover startup races. The host installer has an independent upper-bound deadline. Failed cleanup keeps the operation retryable and cannot report successful cancellation. Root-owned uninstall opt-out markers prevent background sync from reinstalling an intentionally removed agent. Owner chats, projects and configuration remain intact.

### Endpoint contract

| Endpoint | Payload / result |
| --- | --- |
| `GET /api/ai/provider-settings/workflows/capabilities` | At most 32 authoritative harness capabilities |
| `POST /api/ai/provider-settings/workflows` | Strict harness ID, operation kind, supported login method and idempotency key; safe expiring receipt |
| `GET /api/ai/provider-settings/workflows/:id` | Owner-scoped operation status |
| `POST /api/ai/provider-settings/workflows/:id/code` | Owner/attempt-scoped transient Claude authorization code; bounded secret body, no receipt or diagnostic persistence |
| `POST /api/ai/provider-settings/workflows/:id/cancel` | Strict empty body; actual cleanup before cancelled receipt |
| `POST /api/ai/provider-settings/workflows/keys` | Strict bounded masked-input transport; returns only verified boolean |
| `GET /api/ai/provider-settings/workflows/logs/:harnessInstanceId` | At most 64 semantic events, with no raw native output |
| `GET /billing/ai-credit/history` | Strict runtime slot, limit 1–50 and opaque cursor; scoped signed ledger amounts |

Workflow bodies are limited to 8 KiB, operations to 64 retained entries and four queued actions, and key verification to 12 probes per minute. OpenAI verification uses the fixed non-billable models endpoint with a ten-second timeout and rejects redirects. Codex key saving runs the pinned native CLI with stdin in a disposable private staging directory; it verifies the resulting credential file and atomically renames it with mode 0600. No supplied key enters argv or durable generic mutation receipts.

## Auth matrix and limits

| Boundary | Authentication | Validation and limits |
| --- | --- | --- |
| Existing Settings reads/actions | Existing gateway owner/runtime auth | Existing revision/idempotency/body limits; native private identity/quota enrichment requires owner, collaborators receive a redacted snapshot |
| Workflow capabilities/status | Verified gateway principal matching the configured runtime owner | Fixed harness/operation IDs, bounded expiring operations, no public endpoints |
| Login/install/cancel/uninstall | Owner writable capability | bodyLimit before buffering, fixed commands/managed prefix, deadline/reaping, operation identity |
| Browser authorization code | Owner writable credential capability for the exact active attempt | Bounded transient secret input, native PKCE, single submission, no URL/receipt/log persistence |
| Key validate/save | Owner writable credential capability | Separate bounded secret payload, provider allowlist, timeout, safe errors and atomic preservation |
| Usage history | Existing platform Clerk owner auth | Resolve active owner computer from runtime slot; bounded cursor/page, Kysely owner+machine+slot predicate |
| Logs | Owner runtime/exact operation | Bounded redacted projection; no filesystem paths, raw errors or credentials |

GET responses are private/no-store. New DELETE endpoints are mutations and require bodyLimit. All external calls have timeouts. Server-generated URLs and command targets are allowlisted; no user-controlled destinations. In-memory registries have cap/TTL and shutdown cleanup. Cancellation and scope changes reject late completion; a failed cancellation cannot appear successful.

## Final presentation and compatibility

- Use shipped real OpenCode, Hermes, Pi and OpenClaw artwork; this overrides the Figma lettermarks. Resolve assets for Web VM/runtime routes and packaged Electron.
- Installed agents use Connected / Not connected from the exact configured credential/source semantics; inference readiness remains separate. Confirmed Not installed is red, while unknown installation remains Checking installation.
- Use one identically sized project chevron, natural-height/opacity disclosure motion around 200 ms, reversible interrupted transitions and reduced-motion support. Visited bodies remain mounted; collapsed controls are inert and focus returns without scrolling.
- Preserve the open agent through inventory identity reconciliation and asynchronous metadata/status updates. Runtime/owner transport changes reset private drafts, status and operation references. Connect request counters are bounded and preserve other visited rows.
- Current canonical Connected wins over historical failed/expired receipts. Active replacement Connecting remains higher priority. Change account and Disconnect are disabled during replacement; cancellation/retry remains available and settled workflows restore actions.
- No manual Enable control exists. Explicit successful Connect enables only its validated current route. Background refresh/discovery never reactivates saved Off. Compatible account/source/model/route actions and server-advertised Terminal fallback remain in collapsed Advanced configuration, without duplicate primary setup cards.
- Connected cards resolve account identity from the selected account or exact selected source; ambiguous or unrelated accounts cannot supply identity/quota. Show actual available plan/email and authoritative usage/reset. Missing usage is unavailable, not zero. Remaining rounded meters subtract used capacity from full capacity.
- Buy credit remains visible. Necessary unavailable purchase explanation belongs inside its modal, deriving only typed policy/permission/funding observations. Policy restrictions offer administrator/support guidance; refresh is useful only for unconfirmed/transient observations. This never changes purchase policy or grants credit.
- Spendable balance uses authoritative remaining microUSD, excluding reserved credit. Positive sub-cent amounts retain enough precision to avoid showing zero or rounding up to a cent. History preserves signed microUSD precision, bounded pages and opaque cursors.
- Dialog background uses system dark scrim/shadow tokens, without white glow. All button foreground/background pairs remain legible through hover/focus/active states; focus trapping and shell overlay ordering remain shared.

## Scope fences

Loaded history clears before a different loader/runtime can render. Abort and exact request/loader identity prevent late old pages or errors from entering the new dialog. Opening history retains its exact current loader. Checkout submission is scoped to source and callback identity; harmless snapshot updates preserve that callback, while real scope changes invalidate old success, failure and finally effects. No late settlement may close, unlock or mutate a new dialog.

Owner-only optional native account enrichment is negotiated separately from old strict snapshot shapes. Default, opt-out, non-owner and mutation replies omit private enrichment. Private principal proof is never serialized, logged or displayed; current native proof and coherent canonical/funding observations must agree before metadata is attached. Unknown allowance cannot fabricate subscription access. Real HTTP401 expires the Matrix session; HTTP403 owner denial preserves it.

Display-only Matrix inventory/capability badges do not establish model admission. Exact policy, funding, selected model/runtime and canonical readiness still govern execution. Matrix-owned Pi integration must preserve immutable Chat bindings and unknown-usage holds. Sonnet/GLM discovery, admission, marker replies and authoritative settlement are separate outcomes.

## Validation and delivery

Feature-layer tests cover native protocol/key failure, guard lifetime, cancellation/uninstall, owner/runtime changes, metadata privacy, checkout/history scope and grouped semantics. The final regression layer adds combined account/card/disclosure composition and synthetic Electron workflow fixtures. Computed button palette checks run in Chromium and are not native acceptance; synthetic Electron fixtures do not establish real OAuth, subscription, paid checkout or model execution.

Record exact combined source head, client app/build hashes, immutable Preview runtime identity and each actual result. Backend changes require matching Preview VPS plus Electron Desktop; frontend-only acceptance also requires Electron Desktop. Exercise Web Canvas/Web Desktop parity and record Native Mobile management as unavailable where no surface exists. New and resumed Chats retain exact bindings. Claude simulation must be labelled simulation if no subscription is available.

Historical October1 captures and validation reports refer to an older uncommitted implementation and synthetic gateway. They remain archived provenance only. New captures use a distinct output directory and cannot silently replace historical tracked screenshots. No latest combined acceptance is claimed by this spec.

Deliver bounded stacked PRs with latest-head Greptile5/5 and required CI green, plus a separate public documentation PR in the private site repository. Coordinator owns runnable Human Review and any explicitly authorized scoped deployment. This spec authorizes no new payments, grants, access changes, primary-account credential changes or fleet/channel promotion.


## Native Claude subscription completion contract (2026-10-07)

### 1. Scope / trigger

A first Settings browser login can finish successfully in the native CLI while the Settings projection still reports unknown authentication. Completion must read the CLI-owned subscription identity before selecting the exact account. A no-resource admission failure must not leave a permanently protected retry receipt.

### 2. Signatures

- `createClaudeNativeAccountMetadataReader({ executable, cwd, environment, timeoutMs?, runCommand?, assertProfileAvailable? }): () => Promise<ClaudeNativeAccountMetadata | null>`
- Fixed subprocess: `claude auth status --json`, scoped to the same owner home as `claude auth login --claudeai`.
- `ProviderSettingsStore.getSnapshot({ refresh: true, includeNativeAccountMetadata: true })` supplies privately bound current identity to foreground completion. Owner GET transports additionally opt into `includeClaudeAccountDetails=true` for Claude plan labels; old servers may ignore this additive query field.
- Successful completion calls the server-only `ProviderSettingsStore.completeClaudeNativeLogin({ harnessInstanceId, expectedRevision, idempotencyKey })`. The store constructs the exact `owner_claude_profile` selection with enablement, re-observes and independently verifies the current native principal inside serialized mutation admission, and supplies a private completion flag to the actual specialized runtime coordinator. This method is never registered as a public action. Discovery alone does not enable a harness.
- The production Terminal handoff wrapper must preserve this optional private completion method and its store receiver when registering the native workflow runtime. A store without the method remains unsupported; wrapping must neither discard an available method nor fabricate one.
- An explicit no-resource `ProviderWorkflowNotStartedError('conflict')` maps to the existing HTTP409 workflow conflict; no new status enum is added.
- `createGatewayChatProviderCatalog(...).resolveClaudeCredentialLaunch` uses its existing `harnessSettingsSource` to honor an explicitly enabled native Claude source before calling the credential launcher; missing or ambiguous native selection fails before any model invocation.

### 3. Contracts

The authoritative native receipt must report `loggedIn: true`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, a bounded valid email, and the exact owner `.claude` config directory. Only allowlisted Pro, Max, Team and Enterprise plan names may be projected, and only with the additive `includeClaudeAccountDetails=true` read negotiation. Existing `includeAccountDetails=true` clients retain compatible email/identity fields without new Claude plan enum values. Authentication does not depend on the new plan flag. Unknown plans remain unknown. This receipt supplies connection identity; it does not supply quota, a model execution verdict, or paid entitlement admission.

The reader strips provider credential environment variables and foreign `CLAUDE_CONFIG_DIR`, keeps default owner HOME resolution identical to browser login, bounds process time and output, checks writer availability before and after the observation, and revalidates the current principal before attaching metadata. Do not explicitly set `CLAUDE_CONFIG_DIR=HOME/.claude`: official CLI versions use a different global `.claude.json` path in that mode even when the reported config directory matches. The native `owner_claude_profile` source/account and `claude_code_owner_profile` instance are separate from historical `owner_anthropic_profile`, `owner_anthropic` and kernel instances; existing source/instance identities remain unchanged. Explicit native credential resolution aliases only the owner Claude profile and rejects API-key/ambient fallback. Default reads, non-owner reads and mutation replies retain their existing privacy contract. Tokens and authorization codes never enter snapshots, logs, receipts or command arguments.

For explicit logout/removal, the two exact registered terminal records (`owner_claude_profile` / `owner_claude_profile` and `owner_anthropic` / `owner_anthropic_profile`) address one native credential. Count that credential once; independently revocable API keys do not compete with CLI logout, while unknown profiles remain distinct. Canonical native readiness remains unknown: only fresh privately bound metadata authorizes native lifecycle execution. Inside the successfully admitted durable writer callback, a coordinator-owned status reader must verify the same HOME/email/organization before invoking logout. This internal reader may omit the ordinary writer-availability probe only while its coordinator owns that lease; ordinary readers retain all fences. Drift or unavailable identity fails before destructive execution, quota is not required, and proof never becomes public or persisted authority. Removal aggregates dependencies of both exact terminal aliases, preserving active/resumable Chats and unrelated key accounts. Completed lifecycle receipts replay without invoking logout again. A logged-out native profile may be removed only with a separate process-private, HOME-bound signed-out receipt from the official CLI; a null identity read never proves absence. The observed official signed-out protocol is bounded JSON with `loggedIn: false`, `authMethod: "none"`, `apiProvider: "firstParty"`, and the exact owner config directory, including the exit code 1 verified against the installed official CLI. Timeout, signals, malformed or foreign-HOME output, other exits, and unavailable readers remain unknown. Re-observe signed-out state inside the admitted writer lease before removal, and reject a newly appeared login. Logout invalidates pre-action identity and quota enrichment before projecting its mutation response. Removal clears saved configuration/secrets; the installed CLI's fixed inventory descriptor may be rediscovered as disconnected, without restoring credentials or repeating logout.

### 4. Validation and error matrix

| Condition | Required result |
| --- | --- |
| Empty owner home and installed CLI | Browser login may start; prior account files are not required |
| CLI exits successfully and exact native subscription status is current | Select the matching profile and enable the exact harness under revision control |
| Production store is wrapped for Terminal handoff | Preserve private completion through the wrapper; exercise the same registration path used by the server |
| API-key mode, foreign config directory, missing/invalid receipt, changed identity or timeout | Do not certify subscription authentication or select its account |
| Explicitly running managed operation, no new resource acquired | Return conflict with safe busy guidance; discard only the provisional attempt |
| Unknown process liveness or uncertain lease cleanup | Preserve protection; do not kill or bypass a writer |
| Admission failed before acquisition, then the existing process stops | A new attempt can proceed; shutdown has no phantom cleanup task |
| Existing saved API-key, Claude profile or Hermes binding during refresh | Preserve its account, source, enablement and immutable Chat identity |
| Explicit native source with a previously saved API key | Runtime discovery and execution use the same native credential resolver without key fallback |
| Native source disabled, missing, conflicting or ambiguous | Reject before credential acquisition or subprocess invocation |

### 5. Good / base / bad cases

- Good: a fresh-home browser code callback is accepted by a native subprocess, its authoritative status identifies the same owner subscription, and the real store returns Connected for the explicitly selected route.
- Base: no native login exists; show Not connected without fabricated identity or usage.
- Bad: a `.claude.json` marker or CLI exit0 alone is treated as proof, or a busy first attempt poisons every subsequent retry.

### 6. Tests required

- Exercise the full fresh-home guard -> registered HTTP workflow -> subprocess -> native status reader -> **production Terminal handoff wrapper** -> canonical service -> real Settings store -> **production generic harness coordinator and specialized-harness guard** -> revisioned fixed-native selection path. An unwrapped store or stub advertising `select_access_source` cannot establish production wiring.
- Cover both a wrapped store with private completion and one without it, preserve the original store receiver, and verify successful completion is visible in the owner Settings response without expanding public capabilities.
- Reject public generic source selection for fixed native harnesses, stale revisions, unbound or changed principal evidence, missing drivers and mismatched sources/models. Revalidate principal and canonical eligibility before owner configuration persistence; compensate the actual runtime receipt on rejection. A duplicate completion receipt after explicit Off must return current configuration without re-enabling it.
- Cover existing API-key and saved profile routes, unchanged legacy Claude/Hermes bindings, and explicit connection account selection. Exercise the actual runtime catalog resolver with a prior API key to prove explicit native selection cannot silently use it; direct credential-helper tests alone do not establish runtime wiring.
- Reject API-key fallback, foreign home, changed principal, stale/invalid/oversized status and concurrent writers. An unrecognized subscription plan must not fabricate a plan label or invalidate otherwise current native authentication.
- Verify private enrichment is omitted from default, collaborator and mutation responses, and legacy metadata clients still parse their original strict plan enum. New plan labels require the additive query negotiation.
- Verify the actual Web and Electron transports preserve HTTP409 and that workflow busy copy does not replace generic revision-conflict copy.
- Label native protocol fixtures as simulation. Real licensed OAuth and affected-customer acceptance require separate evidence.

### 7. Wrong versus correct

Wrong: native login exits0 -> check a generic unverified canonical profile -> reject successful authorization or enable whichever route was previously saved.

Correct: native writer exits and releases its fence -> read and independently bind current native subscription status -> private serialized fixed-Claude completion -> production specialized coordinator -> revalidate current principal/catalog -> persist the exact account selection and enablement -> refresh the scoped Settings projection. Keep inference readiness and quota unknown unless their own authoritative observations exist.


## Foreground sign-in progress (2026-10-07)

A connection click immediately shows a spinner on its selected card and a labelled “Starting sign-in…” status while the start response is pending. After a running receipt arrives without an authorization URL/code, show “Preparing sign-in page…” rather than an apparently idle finish panel. Once the authorization action is available, retain visible waiting feedback. Failed start, cancellation, terminal receipts and runtime/identity changes clear the scoped loading state; late results from an old scope cannot restore its action or spinner. Use the shared 16px current-color ring, stable indicator slot and reduced-motion treatment.

Tests must delay both the start response and URL publication, verify the eventual action, retry after failure, terminal receipt clearing, cancellation and late-result isolation. These are UI feedback states, not new server workflow enums.


## Claude completion refresh and native allowance

A successful foreground login receipt starts an explicit, indeterminate “Sign-in complete. Updating connection…” phase. The grouped row remains Connecting and account-changing controls stay disabled until the owner/runtime-scoped snapshot refresh settles. This phase is bounded to 30 seconds; failure offers a read-only connection check rather than restarting OAuth. Runtime/account changes discard the old completion feedback. Both Web and Electron use the same composed view and awaitable scoped refresh. Overlapping successful receipt reconciliations use an ephemeral latest-refresh identity within that same scope. Only the current refresh may stop the spinner, clear its own refresh error or report a failure; stale success, rejection or timeout cannot overwrite newer feedback. Scope changes, a new login action and Back invalidate prior refreshes.

Native Claude identity remains verified through official CLI `auth status --json`. Login completion requests identity only: quota failures cannot reject successful authentication. Owner-only Settings snapshot reads may additionally request the native subscription allowance. This is a read-only Gateway operation using the fixed current native profile, never browser cookies, renderer credential access, environment/API-key fallback, token-count estimation or a model call.

The native quota adapter reads a bounded owner-only regular credential file without symlinks, uses its non-expired profile-scoped credential only in memory for the fixed HTTPS allowance endpoint, rejects redirects and bounds request/body size. It normalizes only the five-hour utilization and reset into the existing subscription allowance contract. A process-private credential equality proof and fresh CLI principal observation bind the result to the exact native account/source. Other Anthropic sources and historical Chat bindings do not inherit it. Cache entries hold normalized data and equality evidence only; successful reads are throttled for five minutes, failures for one minute, and account/credential changes or quota resets invalidate reuse. Unknown/malformed/unauthorized/rate-limited quota remains unavailable while valid account identity remains visible.

Validation covers delayed completion refresh in the actual grouped view, refresh timeout/failure/runtime change, private credential safety, bounded malformed upstream data, quota throttling, principal/credential changes, exact-source projection and quota-independent completion. Simulated tests are separate from actual owner Preview/Electron acceptance.

A five-hour reset ends positive-cache reuse immediately, even inside its five-minute TTL; the next read fetches the new authoritative window. Negative results retain their one-minute cooldown. Quota invalidation during either the post-fetch CLI observation or final metadata binding removes only the attached allowance. A still-current, matching CLI principal retains authenticated identity and plan; changed principals, expired identity observations and active writer fences still reject metadata.
