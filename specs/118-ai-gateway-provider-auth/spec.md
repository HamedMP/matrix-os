# Feature Specification: Matrix-Funded AI and Provider Accounts

> **OS-view amendment:** provider readiness, login actions, selected provider/model, safe errors, and Settings/Chat presentation derivation must remain equivalent across Web Canvas, Web Desktop, and Electron Desktop. Web Mobile follows Native Mobile for capabilities available there. See `specs/119-os-view-parity/spec.md`.

**Feature Branch**: `codex/ai-gateway-provider-auth`
**Created**: 2026-08-29
**Status**: Approved
**Input**: User description: "Add AI gateway support so users can begin with free Matrix-funded AI, update the Claude Agent SDK and current Anthropic models, support smooth provider login in Chat, show accurate provider login state in Settings, and compare or adopt useful provider harnesses from t3code. Deliver in stages, starting with a shared Matrix-funded credential before pricing add-ons and metering."

**Delivery status**: This is a staged specification. The canonical read-only V3
provider projection and its compatibility adapters are the current foundation;
the shared Settings redesign, account mutations, funded activation,
allowances/add-ons, and broader harness catalog remain separate delivery
layers. Requirements below describe the approved end state unless a phase is
explicitly identified as implemented in `quickstart.md`.

### Product vocabulary

- A **harness** is the executable agent runtime, such as Hermes, OpenClaw, Pi,
  OpenCode, Codex, or Claude.
- A **model provider** serves inference, such as Anthropic, OpenAI, OpenRouter,
  or Baseten. Matrix AI is a managed gateway/access source, not a model
  provider or provider account.
- An **account** is an owner-scoped authenticated profile for a harness or model
  provider. Multiple accounts may exist for one provider.
- An **access source** is the exact credential and funding path selected for a
  run, such as Matrix included credit, Matrix add-on credit, an owner API key,
  or an owner subscription.

Internal `ProviderDriver` and `ProviderInstance` contract names represent a
harness definition and runnable harness configuration. New user-facing copy
must not use “provider” for both harnesses and inference services.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start chatting without bringing an AI account (Priority: P1)

A newly provisioned user can open Chat and receive a useful response immediately through Matrix-funded AI without first creating a provider account, entering an API key, or opening a terminal.

**Why this priority**: Removing provider setup from first use is the core activation improvement and gives every paid Matrix computer a working AI kernel.

**Independent Test**: Provision an account with no owner provider credentials, open Chat, send a message, and verify that a supported Matrix-funded model responds while the UI identifies Matrix AI as the active access source.

**Acceptance Scenarios**:

1. **Given** a signed-in user whose Matrix computer has no owner provider credential, **When** the user sends their first Chat message, **Then** Matrix routes the turn through Matrix-funded AI and returns the response without a setup detour.
2. **Given** Matrix-funded AI is temporarily unavailable, **When** the user sends a message, **Then** the turn fails safely with a provider-neutral explanation and a retry or connect-provider action; no internal provider or credential detail is exposed.
3. **Given** the operator has disabled Matrix-funded AI globally, **When** an unconnected user opens Chat, **Then** Chat clearly offers supported provider connection paths instead of presenting a model that cannot run.

---

### User Story 2 - Connect and use an owner-funded provider smoothly (Priority: P1)

A user can connect Anthropic or OpenRouter from Chat or Settings using a guided browser-based flow where supported, or enter a provider API key, and can return to the same draft after connection.

**Why this priority**: Owner-funded access gives users continuity after the included trial, preserves provider choice, and prevents Matrix-funded service from becoming a lock-in boundary.

**Independent Test**: Begin from an unauthenticated provider card, complete a connection flow, return to the same Chat draft, and verify that the provider becomes ready and can run the next turn without a page reload or terminal knowledge.

**Acceptance Scenarios**:

1. **Given** an unauthenticated Anthropic account, **When** the user chooses Connect Anthropic, **Then** Matrix starts the supported interactive login, preserves the current Chat draft, and updates readiness after the callback or polling result.
2. **Given** an OpenRouter user, **When** the user authorizes Matrix through the provider's browser flow, **Then** Matrix stores the resulting owner credential securely, shows the connected account as owner-funded, and makes compatible models selectable.
3. **Given** a user prefers an API key, **When** they save a valid provider key, **Then** Matrix verifies it with a bounded provider probe, never returns the secret to a client, and marks the exact provider ready.
4. **Given** a connection attempt expires, is denied, or fails, **When** the user returns to Matrix, **Then** the existing draft remains intact and the provider card shows a safe actionable state.

---

### User Story 3 - See truthful provider, account, and model state (Priority: P1)

A user can open Chat's model picker or Settings and understand which harnesses are installed, which model providers are connected, which account or funding source will be charged, and which models are currently available.

**Why this priority**: The current UI combines inferred file state, runtime installation state, and platform fallback into labels that can look ready when the selected execution path is not actually usable.

**Independent Test**: Exercise Matrix-funded, owner API-key, interactive-login, expired, unavailable, and disconnected states for every exposed provider and confirm that Chat and Settings render the same status and available model set.

**Acceptance Scenarios**:

1. **Given** Matrix-funded AI is active and no owner provider is connected, **When** the user opens Settings, **Then** Matrix AI is shown as ready and included, while Anthropic and OpenRouter owner accounts are shown as not connected rather than falsely ready.
2. **Given** an owner credential exists but fails a bounded health probe, **When** status refreshes, **Then** the provider shows expired, invalid, or temporarily unavailable as appropriate without exposing raw errors.
3. **Given** a model is unavailable for the active funding source or harness, **When** the model picker opens, **Then** the model is hidden or visibly unavailable and cannot be submitted.
4. **Given** provider state changes in another shell, **When** Chat or Settings becomes active, **Then** it refreshes to the same source-of-truth state without requiring a full app restart.

---

### User Story 4 - Use the current Claude model family safely (Priority: P2)

A user can choose among the latest generally available Anthropic models that their selected access source supports, with understandable capability, speed, cost, and data-handling labels.

**Why this priority**: Matrix currently advertises older hard-coded models and cannot safely launch newer model behavior without validating Agent SDK compatibility.

**Independent Test**: Compare the advertised catalog with the authoritative model source, run representative tool-use and resume turns on each enabled model, and verify model-specific behavior is handled without corrupting a Chat.

**Acceptance Scenarios**:

1. **Given** a current model is enabled for the user's funding source, **When** the user selects it, **Then** the selection is used consistently for the turn, resume, and subagent behavior.
2. **Given** a model has different effort or thinking behavior, **When** the model is selected, **Then** Chat exposes only compatible controls and the run does not send unsupported options.
3. **Given** a high-cost or special-retention model is not included in Matrix-funded access, **When** an included user opens the model picker, **Then** the restriction and a supported connection or upgrade path are clear before submission.
4. **Given** a model reports a structured refusal, rate limit, or fallback, **When** the turn completes, **Then** Chat presents a specific safe outcome rather than treating it as a generic success or leaking a raw provider message.

---

### User Story 5 - Add more execution harnesses without fragmenting Chat (Priority: P3)

A developer can add a compatible coding harness or model source behind the canonical provider contract and have it appear in the same Chat, Settings, readiness, and model-selection surfaces.

**Why this priority**: Matrix already has a provider-neutral Chat contract, but broadening it before funded AI and truthful auth are stable would increase support and security risk.

**Independent Test**: Register one additional compatible harness through the canonical contract and verify install, login, capability discovery, model selection, run, resume, cancellation, and safe failure behavior without harness-specific UI branches.

**Acceptance Scenarios**:

1. **Given** a harness supports the canonical capability contract, **When** it is installed and connected, **Then** it appears as another provider instance without creating a new Chat type.
2. **Given** a harness does not support a requested capability, **When** the user opens its controls, **Then** unsupported controls are absent and the run cannot claim that capability.
3. **Given** the harness's upstream project changes its model list, **When** Matrix refreshes the bounded catalog, **Then** current models can be reclassified without silently changing an existing Chat's bound provider instance.

---

### User Story 6 - Configure the same AI system in every desktop shell (Priority: P1)

A user sees the same **Agents & providers** capabilities in Canvas, Web
Desktop, and Electron: harness instances, accounts, login state, selected access
source, routes, models, usage authority, and lifecycle actions.

**Why this priority**: Settings parity is a correctness boundary. A login,
funding, or route that exists in only one renderer creates false state and makes
support depend on which shell the user happened to open.

**Independent Test**: Render one bounded V3 fixture in Canvas, Web Desktop, and
Electron; perform every supported account/harness action and verify identical
availability, labels, guarded transitions, and resulting V3 refreshes.

**Acceptance Scenarios**:

1. **Given** the same owner runtime, **When** the user opens Agents & providers in any desktop shell, **Then** all shells show the same harnesses, accounts, access sources, models, and readiness states.
2. **Given** a CLI-backed login is required, **When** the user starts it from Canvas, Web Desktop, or Electron, **Then** a visible Terminal flow opens through that shell's adapter while the same owner-bound connection attempt drives progress.
3. **Given** an account is bound to active or resumable Chats, **When** the user removes it, **Then** every shell requires reassignment or explicit confirmation and preserves Chat history.
4. **Given** a capability cannot be supported on one shell, **When** that shell renders the feature, **Then** it shows a documented explanatory state rather than silently omitting the control.

### Edge Cases

- The Matrix-funded route is configured but the upstream gateway credential, stored provider key, or prepaid balance is unavailable.
- A user has multiple credential sources for one provider; Matrix must show which source wins and must not silently charge a different account.
- A user begins login in one shell and completes it in another, or closes the original shell before completion.
- A provider callback is replayed, arrives after expiration, or is delivered for a different authenticated Matrix user.
- The upstream reports a successful response with a refusal stop reason, a fallback model, partial usage, or no usage metadata.
- A model is removed from the current catalog while an existing Chat is bound to it.
- A platform-funded request is retried or resumed after the included offer is disabled.
- A burst of parallel turns races a global or future per-user budget boundary.
- A provider status probe times out while an otherwise valid credential exists.
- A Matrix computer is offline; cached status must be shown as stale, not connected or disconnected with false certainty.
- A user deletes a connected account or API key while a run is active.
- Provider telemetry is enabled while prompt and response payload retention is disabled.
- A user logs out of one of several accounts while another account remains ready.
- A user removes an account that is selected by an active or resumable Chat.
- A user disables a harness that still has installed binaries and connected accounts.
- Matrix policy is ready while relay health is stale, or relay health is ready while the owner is ineligible.
- A usage source cannot report a provider balance, or reports allowance data without a monetary balance.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix MUST offer an operator-controlled Matrix-funded AI access source that lets eligible users complete Chat turns without owner-supplied provider credentials.
- **FR-002**: The first release MUST support Matrix-funded access without a user-visible metered allowance, while enforcing a global disable switch, a global spend ceiling, bounded concurrency, request size limits, and abuse-rate protection.
- **FR-003**: Matrix MUST keep upstream billing credentials out of owner-controlled computers, client bundles, logs, error responses, and exported user data.
- **FR-004**: Every funded request MUST be attributable to a verified Matrix user and runtime by the Matrix-controlled request boundary; clients MUST NOT be able to override billing identity.
- **FR-005**: Matrix MUST preserve owner Chat content in the owner's data store; gateway observability MUST default to metadata-only records and MUST NOT retain prompts, responses, tool payloads, file contents, or provider credentials.
- **FR-006**: Matrix MUST represent access source separately from model vendor and execution harness so "Matrix-funded Anthropic", "owner Anthropic login", "owner Anthropic key", and "owner OpenRouter" cannot collapse into one misleading provider state.
- **FR-007**: Matrix MUST support owner Anthropic access through the currently supported interactive account flow and API keys, with explicit precedence and a way to disconnect each owner credential.
- **FR-008**: Matrix MUST support an OpenRouter browser authorization flow that uses replay-resistant request correlation and results in an owner-controlled, revocable provider credential.
- **FR-009**: Provider connection callbacks and status mutations MUST be authenticated, owner-scoped, idempotent, bounded, and safe against callback replay and cross-user credential binding.
- **FR-010**: Matrix MUST verify provider readiness with bounded health probes where the provider offers one; local-file presence alone MUST NOT be presented as verified readiness.
- **FR-011**: Chat, Settings, onboarding, desktop, browser, mobile, and channel-facing status projections MUST derive from one provider-account source of truth and use the same status vocabulary.
- **FR-012**: Provider status MUST distinguish at least included/connected, not connected, setup required, authentication required, invalid or expired, temporarily unavailable, disabled, and stale or unknown.
- **FR-013**: Matrix MUST show the active funding source and account label without returning secrets, internal identifiers, filesystem paths, raw provider errors, or billing details that the user is not authorized to see.
- **FR-014**: Matrix MUST preserve an unsent Chat draft and selected project while an interactive provider setup flow is in progress.
- **FR-015**: Matrix MUST expose only models and controls compatible with the selected provider instance, credential source, entitlement, and harness capability snapshot.
- **FR-016**: Matrix MUST update the Claude Agent SDK only after real-runtime spike tests prove first-turn tool availability, resume, in-process tools, hooks, permissions, cancellation, subagents, and the selected authentication routes.
- **FR-017**: Matrix MUST continue to use the stable query-and-resume Agent SDK path; an SDK upgrade MUST NOT adopt a deprecated or removed session interface.
- **FR-018**: Matrix MUST support the latest generally available Anthropic model family, subject to provider availability and Matrix access policy, and MUST retain a bounded bundled fallback catalog if live discovery is unavailable.
- **FR-019**: Model records MUST describe capability, compatible effort controls, availability, funding eligibility, and relevant user-facing data-handling restrictions.
- **FR-020**: Existing Chats bound to a removed or newly restricted model MUST remain readable and MUST require an explicit compatible selection before another run; Matrix MUST NOT silently rewrite persisted selections.
- **FR-021**: Structured refusals, fallbacks, rate limits, overloads, quota exhaustion, and authentication failures MUST map to safe canonical Chat outcomes.
- **FR-022**: Provider calls MUST enforce timeouts, cancellation propagation, response and stream size bounds, redirect policy, retry limits, and per-run idempotency where supported.
- **FR-023**: The Matrix-funded request boundary MUST not cache stateful Agent SDK turns by default.
- **FR-024**: Any usage or entitlement persistence added after the initial release MUST use owner/platform PostgreSQL through Kysely according to ownership; no new embedded database or ORM is permitted.
- **FR-025**: Later allowance and add-on releases MUST enforce atomic spend reservation or another concurrency-safe budget boundary before a provider call and reconcile the final provider-reported cost afterward.
- **FR-026**: Provider-reported usage and model identity MUST be retained as bounded billing metadata for reconciliation when metering is enabled, without retaining Chat content.
- **FR-027**: New execution harnesses MUST implement the canonical provider driver/instance contract and MUST NOT create harness-specific Chat persistence or renderer-only state.
- **FR-028**: OpenCode SHOULD reuse the existing Matrix harness support rather than be reimplemented from the comparison project.
- **FR-029**: Cursor and Grok harnesses MUST be deferred until a generic, tested protocol adapter makes them a bounded addition; copying comparison-project internals directly is out of scope for the funded-AI release.
- **FR-030**: Baseten MUST be treated as an optional open-model inference source, not as the authority for provider accounts, Matrix entitlements, or multi-provider routing.
- **FR-031**: Every new or changed mutating endpoint MUST have an explicit authentication rule, boundary validation, body limit, safe error mapping, and integration wiring test.
- **FR-032**: The release MUST include operator health, upstream spend, rejection, authentication-source, latency, and error-rate telemetry without high-cardinality secrets or content.
- **FR-033**: The release MUST include rollback controls that can restore the previous direct Anthropic path for owner credentials while disabling only Matrix-funded access.
- **FR-034**: Public product behavior, connection steps, funding labels, privacy behavior, and troubleshooting MUST be documented in a separate public documentation pull request.
- **FR-035**: Cloudflare AI Gateway Unified Billing MUST be the initial Matrix-funded upstream, while Matrix remains the authoritative source for owner eligibility, enabled models, variable balances, and add-on credits.
- **FR-036**: Cloudflare per-user or per-runtime spend limits MUST be treated as defense in depth only; their eventually consistent accounting and bounded rule count MUST NOT replace Matrix's atomic balance enforcement.
- **FR-037**: Add-on purchases MUST credit a Matrix-owned ledger; users MUST NOT need a Cloudflare account or receive direct access to the Matrix Cloudflare credit pool.
- **FR-038**: New product copy and APIs MUST distinguish harness, model provider, account, and access source; an execution harness MUST NOT be presented as an inference provider.
- **FR-039**: Settings MUST organize harness/account/routing operations under **Agents & providers**, Matrix identity and `soul.md` under **Identity & personality**, and reserve **Custom agents** for owner agent definitions under `~/agents/custom/`.
- **FR-040**: `AiProviderSnapshotV3` MUST be the sole provider-state source for Canvas, Web Desktop, Electron, Chat, and Settings; compatibility shapes MUST be projections and MUST NOT infer readiness independently.
- **FR-041**: Canvas, Web Desktop, and Electron MUST expose the same supported provider-setting states and actions through shared schemas, derivations, clients, and feature components, with shell adapters limited to native chrome, navigation, and visible Terminal launch.
- **FR-042**: Matrix MUST support multiple owner-scoped accounts for a provider without overwriting another account, and every runnable harness instance MUST identify its selected account or Matrix-funded access source explicitly.
- **FR-043**: Logout, remove account, and disable harness MUST be separate guarded operations: logout disconnects the selected credential, removal deletes its credential/profile without deleting Chats, and disable prevents new harness execution while preserving configuration and readable history.
- **FR-044**: Removing an account referenced by an active or resumable Chat MUST require explicit reassignment or confirmation and MUST NOT silently change the Chat's funding source.
- **FR-045**: Matrix-funded readiness MUST require both explicit current owner/runtime policy eligibility for an allowed model and fresh bounded relay health; configuration or a legacy platform key alone MUST fail closed.
- **FR-046**: Credit and usage UI MUST identify its authority and freshness; Matrix MUST NOT show an exact remaining balance before the Matrix ledger exists, infer a provider dollar balance from local usage, or convert a subscription allowance into invented currency.
- **FR-047**: CLI-backed account setup MUST open a visible canonical Terminal surface in every supported desktop shell and MUST expose bounded pending, success, denial, expiry, failure, and retry states through one owner-bound connection attempt.
- **FR-048**: Pi and OpenCode provider/model choices MUST be discovered from their installed authenticated runtimes with bounded output, timeouts, safe identifiers, caps, and fail-closed per-harness degradation; Settings and Chat MUST consume the same projected routes.
- **FR-049**: Route UI MUST present the model provider separately from **Paid through** and MUST show Matrix AI only as an access/funding source, never as a model provider.

### Key Entities

- **AI Access Source**: The funding and credential source for a run, such as Matrix-funded, owner interactive login, owner API key, or owner OpenRouter account; includes precedence, readiness, and allowed model policy without exposing the credential.
- **Provider Account**: An owner-scoped connection to a model provider, including provider kind, safe account label, authentication method, verification state, last check, and disconnect lifecycle.
- **Provider Instance**: A concrete execution-harness configuration advertised through canonical Chat, including driver kind, capabilities, model catalog, setup actions, and readiness.
- **Execution Harness**: The user-facing name for the executable agent runtime represented internally by a provider driver and one or more provider instances; installation and enablement are independent from account authentication.
- **Model Descriptor**: A bounded model record with stable ID, display name, capabilities, effort options, availability, access-source eligibility, and data-handling notes.
- **AI Gateway Request Identity**: A platform-verified association among Matrix user, runtime, Chat run, access source, and upstream request; it is not supplied by the browser.
- **Included AI Policy**: Operator-controlled availability and eligible-model policy for the initial unmetered experience, later extended by allowance and add-on entitlements.
- **Usage Record**: Content-free reconciliation metadata for a completed or failed request, including provider request identity, canonical model, token usage, cost basis, status, and timestamps.
- **Spend Reservation**: A future concurrency-safe hold against an allowance or add-on before an external request, with committed, released, or reconciled states.
- **Connection Attempt**: A short-lived owner-scoped interactive login transaction with verifier/challenge state, callback correlation, expiry, and terminal outcome.

### Assumptions

- The initial Matrix-funded offer is available to eligible signed-in users with no user-visible dollar or token meter; exact included duration and later add-on pricing are deferred to the pricing release.
- The owner has approved Cloudflare AI Gateway as the funded upstream and Matrix-owned add-on credits as the hard customer balance.
- A global operator budget and kill switch are mandatory even before individual allowances exist.
- Matrix-funded access defaults to a cost-balanced current model; the most expensive and special-retention models may require owner credentials or a later paid add-on.
- Owner Anthropic credentials always take precedence when the user explicitly selects them; Matrix does not silently switch a run between owner-funded and Matrix-funded billing.
- Provider account secrets remain owner/platform secrets and are excluded from ordinary file sync and export surfaces.
- Organization-shared provider billing is deferred until the organization owner-resolution and billing authority are fully implemented.
- Model catalogs can change more frequently than application releases, but all externally sourced catalog data is validated, bounded, cached, and backed by a shipped fallback.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 95% of newly provisioned eligible users can send a successful first Chat message without entering a provider credential or opening a terminal.
- **SC-002**: A user can complete a supported interactive provider connection and return to the same unsent Chat draft in under two minutes, excluding time spent on the provider's own sign-in page.
- **SC-003**: Across Matrix-funded, connected, disconnected, invalid, expired, unavailable, and stale test fixtures, Chat and Settings agree on provider status and selectable models in 100% of contract tests.
- **SC-004**: No upstream billing credential, OAuth verifier, access token, API key, raw provider error, prompt, response, or tool payload appears in client responses, routine logs, analytics events, or owner exports in automated leakage tests.
- **SC-005**: The global disable switch prevents new Matrix-funded provider calls within 60 seconds without disabling valid owner-funded provider access.
- **SC-006**: Representative first-turn tools, resume, hooks, subagents, cancellation, and provider routing pass against the upgraded Claude Agent SDK on every enabled Anthropic model before rollout.
- **SC-007**: At least 99% of successful funded streaming requests preserve time-to-first-token within 250 ms of the upstream gateway path at p95, excluding provider generation latency.
- **SC-008**: Every funded request is attributable to exactly one verified Matrix user and runtime in content-free operational records; no request is accepted with a browser-supplied or unverifiable billing identity.
- **SC-009**: Global concurrency, request-rate, and spend protections reject excess work deterministically, with no more than the documented bounded overshoot under parallel load.
- **SC-010**: Provider setup failures never clear the active Chat, selected project, or unsent draft in end-to-end tests.
- **SC-011**: Current model availability can be updated without an application release while a failed or invalid update leaves the last valid bounded catalog active.
- **SC-012**: Public documentation and operator rollback instructions are merged before Matrix-funded AI is enabled for all eligible users.
- **SC-013**: The same V3 fixture produces identical harness, account, access-source, model, and lifecycle availability in Canvas, Web Desktop, and Electron contract/component tests, with current visual evidence for all three surfaces.
- **SC-014**: Logout, removal, disable, and active-Chat reassignment failure paths preserve prior visible state and Chat history in 100% of lifecycle integration tests.
- **SC-015**: Matrix AI is never projected ready when either policy eligibility or fresh relay health is absent in the funded-readiness test matrix.
