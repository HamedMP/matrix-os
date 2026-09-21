# Feature Specification: Built-in Jev with Matrix AI Gateway and personal API access

**Issue**: https://github.com/HamedMP/matrix-os/issues/1800
**Linear**: https://linear.app/matrix-os/issue/OM-286
**Created**: 2026-09-21
**Revised**: 2026-09-21 — Gateway and personal API are both supported funding sources.
**Status**: Draft — ready for implementation planning; no product implementation or rollout
**Input**: Make Jev a built-in Matrix capability, using either Matrix AI Gateway or a personal TypeSafe API key and used selectively through MCP and recipes.

## Product definition and scope

Built-in means Matrix ships and maintains the Jev tool adapter, connection UI, capability discovery and usage guidance. Users do not install a third-party Hermes plugin, run an MCP service, or supply a server URL. They select Matrix AI Gateway or connect their own TypeSafe account, then choose which Agents should use Jev.

Jev is a supporting decision capability. The selected primary model remains responsible for planning, writing, coding, complex debugging and final responsibility. Jev is not added as an interchangeable conversational model.

Each call uses the authenticated executing owner's explicitly selected funding source:
- **Matrix AI Gateway**: no personal TypeSafe key required; authorize through Matrix runtime credentials and charge the owner's Matrix AI balance under existing entitlement/budget rules. Service credentials remain server-side.
- **Personal API**: call TypeSafe with that owner's encrypted personal key; TypeSafe bills that account and Matrix does not debit AI credits for the same inference.

Gateway is the recommended setup option when verified available, not an automatic authorization or forced migration. Both sources may be configured; exactly one is selected for a new run. There is no automatic cross-source fallback, even after quota/auth/network failures. Continuing with the primary model follows its existing billing source and is distinct from rerouting Jev.

### In scope for the first release

- One owner-scoped Jev capability with Gateway access and at most one saved personal TypeSafe key; explicit active-source selection.
- Built-in tool exposed through Matrix's shared MCP boundary.
- Choice, score and Boolean-probability judgments over bounded text state, with multiple independent questions per call.
- Connection management, selective recipe guidance, required/optional dependency behavior, safe failure and truthful tool activity.
- Real Hermes Chat acceptance using Matrix's actual provider execution path.
- Equivalent connection/recipe behavior in Web Desktop, Web Canvas and Electron Desktop.

### Conditional browser deliverable

Include browser-use/jev-ultrafast as a bundled browser decision/execution adapter after the feasibility gates below pass. This is a separate capability from generic Jev judgments and Matrix OS navigation. Basic Jev decisions must work without a browser installed. Browser support must be advertised per verified runtime/surface, not inferred from MCP availability.

### Deferred

- Matrix OS observation/action/acknowledgement tools and navigation demo.
- Pixel-based perception, native computer control, and browser surfaces unsupported by the Ultrafast adapter; screenshots are not Jev text input.
- Codex/OpenCode support claims until separately integrated and verified.
- Organization-shared credentials, multiple Jev accounts per owner, universal recipe dependency configuration language.
- Replacing the primary model or conversation compaction.
- Automatic approval gates, universal per-command calls, unlimited subsidized inference and promises of savings.

## User Scenarios & Testing

### User Story 1 — Choose Gateway or personal API (Priority: P1)

A signed-in user enables Jev from Matrix MCP/integrations settings by choosing Matrix AI Gateway or Personal API, without installing a plugin or configuring an endpoint.

**Why this priority**: A working owner-funded connection is the prerequisite for all value.
**Independent Test**: Complete a small real Hermes decision with each source separately; verify correct owner attribution and billing without creating a recipe.

**Acceptance Scenarios**:
1. Given no configuration, show Gateway and Personal API with their billing/data disclosures. Gateway asks for no TypeSafe key; Personal API requests a key.
2. Given a valid key, when the user chooses Connect and test, one fixed small test succeeds before the UI reports Connected. The user is told the test is a billable request.
3. Given an invalid key or unavailable service, connection is not falsely reported as working and a safe actionable status appears.
4. Given another user's connection ID, discovery, testing and invocation cannot access their key, Gateway identity or balance.
5. Given an eligible Gateway and sufficient balance, an explicitly requested test completes and settles against Matrix AI balance. Readiness checks alone do not trigger paid inference.
6. Given unavailable Jev Gateway capability, disabled entitlement or insufficient balance, show the specific safe state and recovery action; never imply that a valid personal key is required to use Gateway.
7. Given both sources configured, show and persist the selected source; switching it applies to newly admitted runs without deleting either configuration.

### User Story 2 — Use Jev selectively in a recipe (Priority: P1)

A user adds Jev to an Agent recipe so suitable bounded judgments can be delegated without a per-chat reminder.

**Why this priority**: Tool availability alone does not tell the Agent when it is useful.
**Independent Test**: Compare the same recipe with Jev selected versus absent, using a bounded classification and an ordinary writing task.

**Acceptance Scenarios**:
1. Given a connected, explicitly allowed tool, when the selected recipe handles a suitable classification batch, it can call Jev and use the structured result.
2. Given a straightforward deterministic action or open-ended writing request, the Agent can complete it without calling Jev just to demonstrate use.
3. Given an optional missing or failing dependency, the primary model continues and the user is informed that Jev was unavailable.
4. Given a required unavailable dependency, the run does not pretend to complete that step; before starting it offers connection repair, and during execution it pauses the dependent work.
5. Given a copied recipe, the recipient selects their own funding source; the author's key, Gateway balance, source preference and private binding do not transfer.
6. Given an old recipe with no MCP dependencies, existing behavior remains valid.
7. Given an Agent recipe edit, new chats use the new policy; existing chats retain their admitted context. Disabling a connection still prevents future dispatches immediately.

### User Story 3 — Manage access and understand failures (Priority: P1)

The owner can replace a key, disable or disconnect Jev and see whether actual decisions succeeded.

**Why this priority**: Users must control access and paid usage.
**Independent Test**: Rotate a key, disable it during a delayed test, and attempt a fresh call.

**Acceptance Scenarios**:
1. Given a working key, when replacement validation fails, the old key remains intact.
2. Given a disabled or disconnected connection, subsequent calls are refused even if a runtime holds stale connection metadata.
3. Given a delayed response from a superseded connection test, it cannot re-enable the connection or overwrite the new credential state.
4. Given a paid request timeout, Matrix does not silently resend it or claim no charge occurred.
5. Given successful Jev output, the activity shows a decision completed; it does not imply a downstream OS action has executed.
6. Given Remove personal key, Matrix deletes only the saved TypeSafe key and explains provider-side revocation. Gateway access is unaffected, but runs pinned to Personal API cannot silently switch.
7. Given Disable Jev, both sources refuse new Jev dispatches; saved configuration is retained. Neither action deletes Matrix balance or disconnects other AI features.
8. Given a source change during a run, existing work stays pinned to its admitted source while current authorization is rechecked. Switching an active run requires stopping and starting a new run; unknown paid calls are reconciled without replay.

### User Story 4 — Consistent access across OS presentations (Priority: P2)

The same owner sees equivalent connection and recipe state in Web Desktop, Web Canvas and Electron Desktop.

**Independent Test**: Connect in one presentation, inspect in another, then disable and verify the next dispatch is refused.

**Acceptance Scenarios**:
1. Connection status, dependency behavior, loading, errors and recovery actions have the same meaning in all three presentations.
2. Switching owner/runtime while requests are pending never applies an older account's response to the new screen.
3. Unsupported older runtimes explain that the capability is unavailable or requires an eligible update; they do not silently drop recipe dependencies.
4. On mobile surfaces that expose these existing settings/recipe capabilities, provide equivalent behavior; record a specific platform limitation before excluding them.

### User Story 5 — Complete browser tasks with Jev Ultrafast (Priority: P2)

A user with an authorized Jev funding source enables browser access, then asks the main Agent to navigate, search or filter an ordinary HTML page. Jev proposes the next observed operation and target; the main Agent retains task scope, text composition and responsibility.

**Independent Test**: Through real Matrix Hermes Chat, search and filter a controlled HTML fixture, then independently verify the result. Repeat with stale state, denied access and disconnected browser.

**Acceptance Scenarios**:
1. Connection settings distinguish Jev API readiness from browser readiness and explain which browser/runtime will execute actions.
2. Each proposal is bound to an owner, run, owned browser session, observation and one-use decision ID. The executor rejects stale, replayed, cross-owner or changed-target proposals.
3. The selected main Agent supplies typed text; no additional OpenRouter/text-model key is required; text generation retains the primary model's existing billing route.
4. Low confidence, unsupported controls, unavailable transport or ambiguous outcome returns control to the main Agent. A failed mutation is never blindly replayed.
5. Jev's DONE result is followed by independent observed outcome verification. Tabs created for the task are closed on completion/cancel/expiry without closing pre-existing user tabs.
6. Credentials, cookies and unrelated private page content are excluded from Jev state. Browser access and sensitive actions retain existing authorization requirements.

### Edge Cases

- API key expired/revoked, account quota exhausted, provider throttling or temporary outage.
- Multiple browser tabs changing policies, duplicate connect clicks and old revisions.
- MCP unavailable although the Jev account itself is valid.
- Unknown question IDs, invalid choices, missing confidence, oversized input/output or nonfinite scores.
- Recipe contains untrusted source text instructing the model to send credentials.
- Connection deleted between tool discovery and execution.
- Response lost after the provider may already have billed; exact usage unavailable.
- Required dependency fails after earlier task steps completed.
- Older clients assume every MCP entry has a URL.
- Current user shares or exports a recipe; private bindings must be removed.

## Requirements

### Functional Requirements

- **FR-001**: Matrix MUST support both Matrix AI Gateway and personal TypeSafe API access as built-in Jev funding sources, with no external plugin/server installation.
- **FR-002**: Every inference call MUST use the authenticated executing owner's admitted funding source. Gateway charges that owner's Matrix AI balance; Personal API uses that owner's key without an additional Matrix AI inference debit. Automatic cross-source fallback is forbidden.
- **FR-003**: Connecting MUST disclose provider billing, billable tests, relevant task-data transmission and Matrix credential storage.
- **FR-004**: Users MUST be able to choose a source, explicitly test it, manage the personal key and disable Jev independently of other Matrix AI capabilities.
- **FR-005**: The tool MUST accept bounded text state with typed independent questions and return validated structured results.
- **FR-006**: The tool MUST NOT accept a key, owner identity, arbitrary endpoint, executable selector/code or permission grant from the model.
- **FR-007**: Recipe MCP dependencies MUST be distinct from ordinary integration dependencies and contain no credential or portable private account binding.
- **FR-008**: Tool access MUST require current connection/tool policy authorization; selecting a recipe alone MUST NOT grant paid use or additional permissions.
- **FR-009**: Users MAY explicitly allow selective calls without confirmation for every judgment; this MUST NOT approve subsequent OS or external-service actions.
- **FR-010**: A supplied shared skill MUST guide selective use, batching, data minimization, abstention and main-model fallback. No forced call per turn.
- **FR-011**: Missing/failed dependencies MUST follow the recipe's explicit required/optional policy.
- **FR-012**: Existing recipes MUST remain valid and legacy remote MCP connections MUST preserve their existing behavior.
- **FR-013**: Connection revocation MUST be checked before future dispatches; in-flight requests cannot be represented as retractable or guaranteed unbilled.
- **FR-014**: Paid inference MUST NOT have hidden automatic retries; repeated delivery of one broker request MUST NOT dispatch another chargeable call.
- **FR-015**: Tool activity MUST distinguish discovery, successful real invocation, failure and downstream execution; usage/cost savings MUST NOT be fabricated.
- **FR-016**: A confidence threshold is a delegation preference, not a guarantee. Missing/low confidence or malformed output MUST hand judgment back to the main model.
- **FR-017**: State/input/output bounds, execution deadlines and owner concurrency/rate limits MUST prevent unbounded cost/resource use.
- **FR-018**: Plaintext keys MUST NOT appear in returned metadata, runtime projections, prompts, tool arguments, recipe exports, logs or analytics.
- **FR-019**: Recipe copies MUST resolve against the executing user's own connection; private source-owner bindings MUST NOT transfer.
- **FR-020**: Settings and recipe behavior MUST satisfy applicable OS presentation parity, including empty/disabled/loading/error states.
- **FR-021**: Real Hermes support MUST be verified through Matrix Chat's provider path; upstream plugin presence or mock tests alone are insufficient.
- **FR-022**: Public documentation MUST explain setup, costs, transmission, optional/required behavior, disabling and limitations.
- **FR-023**: Feature rollout MUST expose a capability only to compatible clients/runtimes; unsupported versions MUST fail explicitly rather than corrupt or silently lose configuration.

- **FR-024**: The Ultrafast browser adapter MUST use the same executing-owner selected-source and billing boundary and separate browser authorization; connecting Jev alone MUST NOT grant browser access.
- **FR-025**: Browser actions MUST operate only on fresh observed controls through a trusted executor; model output MUST NOT become executable code, arbitrary selectors or authorization.
- **FR-026**: Browser sessions MUST be owner/run isolated, bounded, cancellable and cleaned up; never attach a shared customer browser profile or expose an unauthenticated debug port.
- **FR-027**: Browser decisions MUST use one-use, observation-bound proposals, independent action permissions, deadlines and a bounded step budget; outcomes with uncertain execution MUST be re-observed before any retry.
- **FR-028**: Browser integration MUST support main-Agent-authored text and MUST NOT require a second text-generation API key.
- **FR-029**: Browser support MUST be capability-gated until real target-runtime tests pass; missing capabilities MUST be visible and gracefully hand back.

- **FR-030**: Gateway MUST verify Jev evaluation capability, owner/runtime authorization, model policy and available credit/budget before dispatch, with atomic reservation/settlement and versioned pricing using existing Matrix metering.
- **FR-031**: Run admission MUST pin the explicitly selected source. Settings changes apply to new runs; no model-controlled argument, recipe import or failure may change an active run's payer/source.
- **FR-032**: Readiness MUST be per source and distinguish unsupported capability, permission denial, insufficient balance, missing/invalid personal key and transient outage; metadata readiness checks MUST NOT incur inference charges.
- **FR-033**: Receipts and activity MUST record the admitted source and available usage/settlement status without secrets. Deduplication MUST survive source changes; an ambiguous call cannot be reissued against another source.
- **FR-034**: Existing personal-key configurations MUST retain their source on upgrade. Portable recipes MUST describe Jev capability without exporting source preferences, billing authority or credential bindings.

### Key Entities

- **Jev configuration**: owner, enabled state, selected source, per-source readiness, optional personal credential reference, revision and tool-use policy.
- **Run source binding**: authenticated owner/runtime, gateway or personal_api, admitted configuration revision and server-resolved authority. Immutable for the run; credentials can rotate within the same owner/source after live validation.
- **Gateway usage reservation/settlement**: owner-bound existing Matrix funding records, versioned Jev pricing and usage reconciliation; no parallel credit ledger.
- **Private credential**: encrypted owner-bound key, rotatable and deletable; never part of model context.
- **Decision request/result**: bounded task state, typed questions, structured answers, execution status and available usage metadata.
- **Recipe MCP dependency**: portable capability/tool identifier, selective usage guidance and required/optional fallback policy.
- **Resolved dependency**: runtime-only owner connection binding, capability version and admission state.
- **Invocation receipt**: request identity and dispatch/completion/unknown status needed to avoid duplicate paid calls.
- **Tool activity**: user-visible evidence of actual invocation; contains no secret and does not imply downstream success.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Gateway and Personal API each complete a real Hermes decision without external installation/endpoint entry; Gateway acceptance has no personal TypeSafe key configured.
- **SC-002**: Choice, score and Boolean-probability acceptance cases each complete successfully, including one multi-question batch.
- **SC-003**: Every invalid-key, disabled, disconnected, rate-limited and timeout fixture produces the specified safe outcome; none silently switches funding source.
- **SC-004**: Cross-owner and recipe-copy tests show zero access to another user's credentials.
- **SC-005**: Sensitive-output tests find zero plaintext key occurrences in all specified public/persisted outputs.
- **SC-006**: Every supported presentation passes the same connection and recipe acceptance scenarios.
- **SC-007**: Existing recipe and remote MCP regression suites remain green.
- **SC-008**: A duplicate broker request causes at most one outbound inference dispatch; ambiguous paid timeouts are not silently retried.
- **SC-009**: A fixed evaluation set includes suitable and unsuitable tasks, failures and ambiguous decisions; report observed success, main-model usage, Jev usage and total latency without a preclaimed improvement.
- **SC-010**: An exact-head Human Review demonstrates the real user flow and confirms that the activity corresponds to an actual Jev call.

- **SC-011**: A verified Matrix runtime completes search/navigation/filter demos through Hermes, Jev and Ultrafast, with independently checked outcomes and measured latency/usage.
- **SC-012**: Browser tests reject cross-owner sessions, stale/replayed proposals and unauthorized actions; cancel/timeout tests leave no orphaned owned sessions.
- **SC-013**: Browser unavailable/unsupported-page cases preserve the main task and report a truthful fallback; no second text-model key is configured for acceptance.

- **SC-014**: Gateway success, denied policy, zero balance, reservation rejection, duplicate settlement and unknown usage tests demonstrate correct owner charging and no unmetered dispatch. Personal API tests demonstrate zero Matrix AI inference debit.
- **SC-015**: Source-switch races, recipe imports and mid-run credential revocation never switch payer or duplicate a dispatched decision; existing BYOK settings remain personal_api.
- **SC-016**: Ultrafast exercises both sources through the same decision contract, without extra text-model keys or a separate credential path.

## Assumptions and dependencies

- One owner configuration with two selectable sources, Hermes first, no organization-wide credentials. Existing BYOK configurations remain personal_api on upgrade; no automatic billing migration.
- Matrix retains encrypted keys in its existing credential/control-plane boundary; BYOK does not mean secrets never traverse Matrix.
- TypeSafe supports typed text decisions. Raw screenshot perception and general action execution are separate capabilities.
- Shared MCP broker availability, per-source authorization, personal credential encryption, Gateway metering and installed Hermes compatibility are prerequisites to verify before release.
- Existing research is based on Matrix snapshot 7d690f5c9; recheck code drift before implementation.
- Detailed architecture and interfaces belong to the accompanying design and plan; this document defines product behavior.

## Delivery boundary

First release scope: both funding sources + builtin decision tool + recipe guidance + real Hermes acceptance for each. Each source has its own capability gate; partial rollout must label an unavailable source explicitly.
Conditional next deliverable: bundled Jev Ultrafast browser adapter after feasibility and security gates.
Independent follow-up: Matrix navigation observation/action/acknowledgement bridge, then separately verified additional harnesses.
Neither this spec nor issue creation authorizes production deployment.


## Ultrafast feasibility gates and evidence

Source inspected: [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast), commit `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`, 2026-09-21. MIT license; Python >=3.12; browser-harness==0.1.13; httpx. Upstream creates an owned Chrome tab through CDP, observes indexed DOM controls, proposes actions, and checks freshness/occlusion. Its default text helper uses a separately configured text-model key. Matrix must replace that handoff with the current Agent's text; this remains a product integration requirement.

The upstream README excludes frames, shadow roots, canvas, uploads, popup tabs, nested scrolling and arbitrary keyboard widgets from its MVP. Tabs share the connected Chrome profile. Its reported speed is a narrow upstream benchmark, not a Matrix performance claim.

Before adopting:
- Prove Browser Harness connectivity and lifecycle in the intended VPS browser runtime. Separately prove an authenticated local bridge before claiming access to a user's local Chrome from a VPS Agent. Electron app control is not implied by Chrome CDP support.
- Pin and bundle audited source/dependencies, preserve MIT notices, and verify redistribution and runtime installation. Avoid customer-side git clone/uv setup as the product experience.
- Replace process-global credentials/shared daemon assumptions with owner-scoped sessions and the existing credential broker. Do not copy the developer's local adapter/key-file convention into production.
- Route decisions through the same paid-call policy/receipts as jev_judge. Bound dynamic operation/target tables; if a page cannot fit the validated decision schema, hand back rather than silently truncate valid targets.
- Demonstrate redacted/minimized state, network destination policy, redirect/SSRF protection for server-hosted browsing, session isolation, cancellation, action authorization and independent outcome checks.
- If any gate fails, keep the browser capability unavailable with a documented blocker while shipping the independently verified decision capability.

Evidence here is source review only. No Matrix Ultrafast runtime acceptance has been performed.

## Gateway implementation evidence and release gate

The last inspected Matrix baseline was `e62d3fc62`. Merged PRs [#1780](https://github.com/HamedMP/matrix-os/pull/1780), [#1781](https://github.com/HamedMP/matrix-os/pull/1781) and [#1782](https://github.com/HamedMP/matrix-os/pull/1782) establish funded metering and client/relay integration. That inspected relay maps Sonnet/GLM, not a verified Jev evaluation route. The meeting reports Jev gateway availability, but this spec does not assert a deployed Matrix Jev endpoint or successful billing validation.

Gateway support requires a verified evaluation request/response adapter, approved Jev model/pricing configuration, ordinary owner-runtime credentials, credit admission and actual settlement evidence. An upstream model listing or chat-completions route is insufficient. Gateway remains unavailable until these checks pass; users may explicitly select Personal API independently. The chosen upstream vendor/endpoint is server configuration, not a user/model field.
