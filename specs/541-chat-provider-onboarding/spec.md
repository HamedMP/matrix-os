# Chat startup and provider onboarding (ENG-60)

Status: implemented startup/onboarding and responsive picker; Human Review pending. Validation and runtime provenance are recorded in PR #2061 and ENG-60.

## Goal and scope

New users should enter an open Chat and connect Claude Code or Codex directly from its empty state. The request includes startup, provider connection, compact composer behavior, and model-picker connection discoverability. Further integration onboarding and a broader visual redesign are deferred until their design is available.

The implementation must cover Electron Desktop's native Chat and the shared Web Desktop / Web Canvas Chat paths. Shared responsive Chat retains the same state semantics. Native Mobile startup redesign is outside this desktop request.

## Required behavior

1. On a normal runtime entry, wait for persisted OS-view restoration, then open the canonical Chat once only if it is not already open. An existing open Chat, including a minimized surface, is left untouched: no reopen, focus change, route reset, or draft loss. Explicit launch links retain precedence. Refreshes, switching presentations, ordinary renders, and a manual close must not trigger repeated reopening.
2. When fresh authoritative provider state confirms no provider is connected, show Claude Code and Codex connection controls in the empty Chat state. Reuse supported Settings connection actions, progress, and errors. Do not infer connection from installation or saved selection. Connected status and send readiness remain separate: a connected but disabled, unfunded, or unavailable route must not be mislabeled as disconnected.
3. Unknown, loading, and failed reads remain distinct from confirmed disconnected state. Keep draft composition available while sending remains governed by existing readiness/admission rules.
4. Refresh readiness after a connection action completes or the user returns from authentication. Provide bounded manual refresh recovery without restarting the application. Preserve drafts and immutable existing Chat bindings.
5. Any connected provider, including Matrix AI, Hermes, Pi, or another supported provider, suppresses connection onboarding even when Claude Code and Codex are disconnected. Preserve normal Chat behavior and its existing availability/recovery UI. Existing conversations must not be replaced by onboarding.

6. A narrow Chat middle column compacts the model-picker label according to the composer container width, even within a wide Electron Desktop window. Keep the full route in the accessible label/title, retain model/Settings/preview/file/send actions, and restore the expanded label when the composer has space. Draft text survives resize and preview toggles.
7. Clickable provider rail entries keep normal color/opacity regardless of authentication status. Selected highlighting and genuinely disabled or locked controls remain distinct. Unsupported model routes remain unavailable for sending.
8. Advertised Connect Claude/Codex actions inside the picker render as prominent filled buttons and retain the existing server-owned action path. Another connected provider suppresses the empty-state guide but does not hide setup for the disconnected provider.

## Invariants

- Source of truth: gateway provider settings/catalog and readiness; persisted owner OS view and existing canonical launch contracts.
- Lock / transaction scope: no new database writes or persistence schema. Existing provider mutations remain server-owned.
- Acceptable orphan states: abandoned login attempts follow the existing expiry/cancel contract; no Chat/conversation is created just to render onboarding.
- Auth source of truth: selected-runtime authenticated transport and existing server permission checks. The new UI never handles credentials directly or manufactures shell commands.
- Resource policy: bounded requests, existing cancellation/stale-runtime guards, no new unbounded polling or registries.
- Deferred scope: integration onboarding, broader Settings design, new provider auth policy, funding changes, production fleet rollout, and Native Mobile startup changes.

## Acceptance and delivery

- Tests first for one-shot startup, restore ordering, explicit launch precedence, duplicate prevention, preserving active Chat/drafts, provider-state classification, and actual connection controls.
- Component integration tests must exercise native and hosted Chat empty states plus successful, pending, cancelled, failed, and stale-runtime authentication outcomes.
- Regression tests retain Settings connection behavior and usable alternate providers.
- Build and inspect the exact-head Electron Desktop with a fresh profile and restored state. Fixture evidence and live selected-runtime evidence must be recorded separately. Fresh-runtime credential projection corrections additionally require matching Preview VPS validation; use the existing pr-2061 runtime without logging out or modifying other computers.
- Deliver one primary implementation PR for ENG-60 and a companion public documentation PR in the private `FinnaAI/matrix-os-site` repository under `content/docs/`.
- Present an exact-head runnable Human Review flow. The latest user instruction authorizes merging after real Preview/Electron acceptance, current-head Greptile 5/5 and green CI. Production fleet rollout remains outside scope.

## Executable contracts

### Scope and trigger

Web Desktop/Web Canvas bootstrap and Electron Desktop restoration consume one startup decision per authenticated runtime entry. Provider onboarding is mounted only in new/empty Chat presentation; the composer remains mounted outside the provider panel.

### Signatures and existing routes

`shouldOpenChatOnStartup({ settled, consumed, explicitLaunch, navigationChanged, chatOpen }): boolean` is shared by both renderers. Open/minimized Chat counts as present. Restore/catalog/mode settlement precedes the decision. A manual navigation or explicit launch consumes the automatic entry decision.

Electron captures an explicit non-Chat entry before restoration adds other tabs, preserving its focus. Web explicit ordinary/shared launches execute once even if navigation changes while loading; the navigation guard applies to automatic Chat only.

`deriveChatProviderConnectionState(snapshot, failed): connected | disconnected | checking | unknown | unavailable` uses the Settings snapshot, separately from the existing send admission logic.

| Existing route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/ai/provider-settings?includeCapabilities=true` | Selected-runtime authenticated transport | Validated connection snapshot and advertised methods |
| `POST /api/ai/provider-settings/actions` | Existing writable provider permission | Revisioned/idempotent `start_login`; no new auth policy |
| `/api/terminal/sessions` | Existing selected-runtime terminal permission | Open the exact server-returned session |

### Request and response boundaries

Use `ProviderSettingsController` for schema validation, request cancellation, revision/idempotency, safe errors, and accepted login attempts. Select an advertised harness/method and eligible existing account identity; a missing method disables that row. Never enable an Off provider implicitly. Follow only the validated server action (`open_terminal` with exact `terminalSessionId`, or the supported authorization path).

Identity comprises runtime/account generation on Electron Desktop and gateway origin on the hosted Chat. Reject completion/action effects when identity changes. Refresh on focus/visibility return or `Check connection`; deduplicate concurrent refresh requests and invalidate the existing catalog after an accepted explicit refresh.

`ProviderSettingsController.refresh({ refresh: false })` is a silent snapshot read: it does not probe local authentication or emit catalog-change notifications. A panel receiving the shared catalog-change event uses this path; user/focus refresh uses the default probe and notification. This prevents two mounted empty Chat panels from indefinitely refreshing one another.

### Validation and error matrix

| Evidence | Presentation |
| --- | --- |
| Authenticated account/harness or ready access source with authoritative observation | Existing new-Chat content |
| Connected provider disabled or configured Matrix source awaiting credits | Existing readiness/funding recovery, no login guide |
| Confirmed no connected provider | Claude Code and Codex connection rows |
| No snapshot | Normal Chat content while connection evidence loads; existing catalog/loading controls remain authoritative |
| Unknown/stale/unverified local login evidence | Normal Chat content and existing model recovery; no onboarding replacement or authentication claim |
| Snapshot read failure | Normal Chat content with a compact manual retry; no replacement onboarding status gate; positive connected evidence suppresses the retry |
| Login mutation/action failure in confirmed disconnected flow | Safe generic error and bounded retry/continue controls |
| Old runtime response | Discarded; no terminal/browser action |

### Good, base, and bad cases

- Good: restore a minimized Chat alongside another active app; preserve Chat geometry and active app, without another open/focus call.
- Base: fresh entry with disconnected installed Claude; open Chat once, request the advertised login, foreground its server-owned Terminal, refresh after auth, retain the draft.
- Bad: installed CLI or remembered model selection treated as authentication; a late bootstrap/login response reopens Chat or acts on another runtime.

### Tests required

Startup policy and renderer integration tests assert restoration ordering, current navigation precedence, existing/minimized preservation, entry replacement, and manual close. Shared/hosted/native provider tests assert truthful evidence, supported actions, identity rejection, failures, and draft retention. Built Electron E2E verifies actual Chat and Terminal windows, one server command, connection transition, and closing Chat without reopening. Fixture auth is not live provider acceptance.

### Wrong versus correct

Wrong: unconditionally call `openChat()` from a provider/presentation effect, or run a fabricated `claude auth login` command from Chat.

Correct: consume the shared startup predicate after restoration; submit the existing Settings mutation and open only the server-returned session while the initiating runtime remains current.

Companion documentation: https://github.com/FinnaAI/matrix-os-site/pull/143 (preview wording until release).

## Responsive picker presentation contract

- Container: `shared-chat-composer` establishes `chat-composer`; the native selected-model trigger collapses its visual route label at the same constrained-width boundary as secondary composer controls. Its unchanged accessible name and complete route title remain available while compact.
- Shared provider rail: dim only truly disabled buttons, never infer visual disabling from `data-availability`. Availability controls model admission and recovery copy; provider browsing with a supported setup action stays discoverable.
- Setup: preserve server-advertised labels and callbacks. Connection actions are content-width, left aligned, about 32px high with 12px text; cap width at the pane and allow long labels to wrap. Use `--model-choice-action: var(--primary, var(--accent))` for filled connection buttons, paired `--text-on-accent` / `--primary-foreground` foreground, and a separate focus token. Web accent is an interaction surface; it must not be used as the primary fill when a primary token exists. Validate real computed contrast across native/hosted themes.
- Tests: built Electron Desktop uses a wide window with a 320px actual composer, long Hermes label, toolbar bounds/no wrap, preview/draft preservation, expanded restoration, normal Claude/Codex icon opacity, and connection through the existing foreground Terminal. Another connected provider suppresses the onboarding guide in the same scenario. No real provider login is claimed by fixture evidence.

### Real VPS correction: connection inspection must not gate Chat
Render the connection guide only for `deriveChatProviderConnectionState(...) === "disconnected"`. Other states retain the supplied normal Chat content. Keep evidence classification truthful and canonical catalog/send admission unchanged. Tests assert no connection-status replacement for checking/unknown/read failure and preserve supported disconnected login wiring. Live primary VPS evidence and built-client provenance are independent; a successful fixture is not proof of live provider availability.

### Fresh runtime credential projection acceptance
A new unauthenticated VPS must show the connection guide after its fresh credential inspection completes. Settings projection must preserve authoritative missing-credential evidence even when an unconfigured account is omitted or a model catalog is unavailable. Optional discovery alone does not establish a connection; failed/unknown probes on a configured route remain uncertain. Collect short-lived negative local observations late enough that unrelated native catalog reads do not expire them before the client receives the snapshot. No TTL extension, synthetic authentication, or send-admission bypass is permitted.

Tests reproduce the real canonical-to-Settings snapshot and assert disconnected fresh Chat plus suppression for existing credentials, configured custom routes, and failed probes. Live Electron Desktop acceptance must independently confirm the guide on the exact-head pr-2061 bundle and normal Chat on the user's existing connected runtime.

## Fresh-runtime missing credential contract

### Scope / trigger
A fresh VPS can omit unconfigured account-backed sources from Settings while canonical inventory still records missing credentials. Preserve that negative connection evidence independently of model-catalog availability, without making the route executable.

### Signatures
`projectMissingCredentialAuth({ canonical, stored, source, driver, now }): "unauthenticated" | undefined` participates only in `projectProviderSettings` harness authentication projection. `AiProviderService.getSnapshot({ refresh })` collects the bounded Codex observation after independent metadata/catalog reads settle, on both refreshed and silent reads.

### Contracts
Only an omitted configured canonical owner source with matching vendor/model eligibility and explicit `setup_required` or `auth_required` qualifies. Any source/driver local observation must be `absent` and satisfy `checkedAt <= now < staleAfter`; preserve original timestamps and five-second observation lifetime. The helper provides no account/source execution binding. Shared connection derivation ignores discovery metadata only when a `harness_profile` source has unknown readiness/unknown observation and no harness selects or configures it.

For presentation, validate absence against the authoritative snapshot's `refreshedAt` on the same server clock as its observation. Do not compare server timestamps with the client wall clock: real Preview acceptance reproduced a 0.6-second offset that incorrectly rejected fresh absence. Render the coherent snapshot until a new read replaces it; refresh on existing focus, visibility, catalog and explicit retry paths. A new snapshot whose observation was expired, future or missing at generation remains unknown. This presentation does not change authentication, TTLs or send admission.

### Existing named Terminal handoff compatibility

Live Connect acceptance exposed a second integration defect: the login coordinator persists named Terminal aliases, while current clients open canonical `workspaceId:tabId` references. Project the authenticated mutation response's `open_terminal` action to the exact existing tab reference using the owner runtime registry. Apply projection after store mutation/replay so cached idempotent receipts are covered as well as new and recovered attempts. Keep internal names, receipt hashes, expiry, idempotency and recovery behavior unchanged. Resolve only an exact unique named tab, validate its reference, and fail closed with a safe error on missing, ambiguous or invalid identity. Never create another tab during projection or guess an identifier in the client. Authentication and Terminal permissions remain authoritative at their existing boundaries.

Keep this behavior in a focused handoff helper and registry resolver; existing large server entrypoints contain dependency registration only. Tests must prove fresh and replayed responses yield the same actual tab, dependency wiring is validated, unsupported/browser actions retain their existing semantics, and missing/ambiguous identities cannot open a Terminal. Real Electron acceptance must click Connect and observe the existing login Terminal on the selected Preview.

### Validation / error matrix
- Explicit matching missing credentials, no contradictory observations: unauthenticated projection.
- Present, unknown, stale, future, or timestamp-free local observation: no negative override.
- Unknown/unavailable configured source, different vendor/model, or missing source reference: no negative override.
- Positive or configured native profile: retain normal Chat. Read failures never imply disconnection.

### Good / base / bad cases
Good: fresh canonical source survives optional Pi catalog failure as negative auth evidence; newly collected Codex absence remains fresh at response time. Base: connected account bypasses the guide and existing admission remains authoritative. Bad: treating a failed probe as no login, or extending an expired observation's timestamp.

### Required tests
`tests/gateway/provider-settings-chat-onboarding.test.ts` exercises canonical service -> Settings store -> authenticated Hono route, both refresh modes, rejected negative timestamps, configured/native positive uncertainty, connected accounts, and the existing server-issued Terminal action with no projected account. Built live Electron E2E checks explicit disconnected guide actions and exact client/runtime provenance.

### Wrong versus correct
Wrong: derive disconnection from unavailable models or replace an expired timestamp with response time. Correct: retain matching canonical missing-credential evidence, collect short-lived observations after slow catalogs, and suppress the guide on configured or positive local evidence.

### Short-window recovery reachability

Native global/project Chat and hosted empty-state content must own bounded vertical scrolling at both narrow and wide widths. At short heights, initial connection-read recovery remains reachable without clipping or moving the composer. A real Electron window-size regression must scroll to and invoke the retry action while retaining the composer.
