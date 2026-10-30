# Feature Specification: Collaboration Preview Pair

**Feature Branch**: `2689-collaboration-preview-pair`
**Created**: 2026-10-30
**Status**: Draft — ready for planning
**Tracking**: [ENG-418](https://linear.app/matrix-os/issue/ENG-418/add-collaboration-preview-pairs-with-isolated-electron-apps), assigned to requester Nima
**Related work**: [ENG-36](https://linear.app/matrix-os/issue/ENG-36) (live collaboration acceptance), [ENG-325](https://linear.app/matrix-os/issue/ENG-325) (general PR previews), [ENG-348](https://linear.app/matrix-os/issue/ENG-348) (bounded Preview AI allowance)
**Input**: User description: “A preview VPS pair sharing the same organization, generated for a ready PR, with two separate Electron apps launched by local Codex so collaboration can be tested end to end before merging.”

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Obtain a matched pair from an unmerged PR (Priority: P1)

A maintainer requests a collaboration preview for one open PR. The result is two
new test computers, each owned by a different dedicated test account. Both
accounts belong to the same dedicated test organization. The pair report names
the exact candidate commit, both computers, matching desktop downloads, readiness,
and expiry. No customer computer or release channel changes.

**Why this priority**: A repeatable pair removes the need to merge a potential
fix or upgrade a customer's computer before testing it.

**Independent Test**: Request one eligible PR preview and inspect both computers
through their respective normal account sessions. Confirm distinct ownership,
shared test-organization membership, matching installed/running candidate
versions, and an unchanged customer-runtime inventory.

**Acceptance Scenarios**:

1. **Given** an open same-repository PR and an available dedicated test-account pair, **When** a maintainer requests a collaboration preview, **Then** exactly two test computers are allocated, their owners are distinct, and both are bound to the requested immutable commit and the same test organization.
2. **Given** both computers are healthy but one has the wrong running version, stale collaboration registration, or missing membership, **When** readiness is evaluated, **Then** the pair is not advertised as ready and the report identifies the failed prerequisite without exposing secrets.
3. **Given** repeated or concurrent requests for the same active PR preview, **When** they are admitted, **Then** they return or reconcile one pair rather than creating additional computers or assigning the same test identity to another active pair.
4. **Given** only one computer has been created when provisioning fails, **When** the run settles, **Then** it reports failure and the exact surviving test resources are either reconciled by a bounded retry or visibly queued for cleanup; it never reports a complete pair.
5. **Given** an ineligible PR or exhausted Preview capacity, **When** a preview is requested, **Then** no privileged candidate execution occurs; the requester receives a denial or a visible queue position without a half-reserved pair.

---

### User Story 2 - Open two independent Electron apps locally (Priority: P1)

The tester gives local Codex the pair reference. One documented launch action
opens two Electron Desktop instances side by side, visibly labeled owner and
member. Each uses the candidate desktop build, its own local profile and its
corresponding account and computer. Normal authentication remains required.

**Why this priority**: Separate accounts and computers must be usable together
on one laptop without accidentally testing the same identity twice.

**Independent Test**: Use a known-ready pair to launch both apps while the tester's
normal Electron app is already running. Verify three independent sessions, then
restart or sign out of one preview app and confirm the other two are unchanged.

**Acceptance Scenarios**:

1. **Given** a ready pair and a matching desktop artifact for the local operating system and architecture, **When** the tester or local Codex invokes the documented launcher, **Then** two independent Electron processes open with distinct profiles and visible role, computer, organization, and candidate identifiers.
2. **Given** one preview profile is unauthenticated, **When** its normal sign-in flow completes, **Then** only the expected test account and computer satisfy that profile's readiness check; another account leaves an actionable mismatch instead of silently switching identity or organization.
3. **Given** both preview apps and the normal app are running, **When** the tester signs out, relaunches, or receives an authentication callback in one preview, **Then** credentials, cookies, navigation, instance ownership, and computer selection do not cross into another profile.
4. **Given** a missing, tampered, expired, or wrong-commit manifest or desktop artifact, **When** launch is requested, **Then** launch stops with a safe recovery instruction; it never substitutes the normal installed app, another PR, a production login target, or an incompatible build.
5. **Given** a second launcher request for the same pair, **When** the two expected profiles already run, **Then** the existing pair is reused or focused rather than creating duplicate sessions; stopping the launcher closes only processes it owns.

---

### User Story 3 - Test the real sharing journey in one review cycle (Priority: P1)

The tester uses a fresh private project in the owner's app, shares it through
the normal UI, then opens it and sends a prompt as the member in the second app.
An outsider account verifies denial. The report distinguishes a usable test
environment from the candidate feature's actual pass or failure.

**Why this priority**: Booting two computers is useful only if the environment
can expose the collaboration defects that previously escaped pre-merge testing.

**Independent Test**: On an existing pair, execute the fresh-project journey
through actual clients and services, save the observations, and reopen the
member's Chat to verify the response persisted. Repeat with a known failing
candidate and verify the report records a product failure without repairing it.

**Acceptance Scenarios**:

1. **Given** a fresh private project and verified shared test-organization membership, **When** the owner chooses Share for the first time, **Then** the tester can observe whether the sharing dialog opens on the first attempt and whether publication remains private until explicitly confirmed.
2. **Given** the candidate supports successful publication, **When** the owner confirms sharing and the member opens it from Shared with me, **Then** membership activation uses the real organization/project authorization and an inherited project Chat accepts a prompt and persists its actual response on the owner's computer.
3. **Given** a separate authenticated outsider who is not in the test organization, **When** that account tries discovery, the project link, or a Chat prompt, **Then** access is denied and no owner-side prompt executes.
4. **Given** either sharing-at-creation or sharing-after-creation is under test, **When** its scenario runs, **Then** it begins with a different fresh private project and records creation, the sharing indicator, dialog behavior, publication and peer visibility separately.
5. **Given** an owner restart or interrupted setup before publication, **When** the owner reconnects and the scenario resumes, **Then** recovery and member discovery are checked explicitly; a failed attempt is not reported as shared and does not broaden access.
6. **Given** a scratch project without its own Git repository, including a reproduction fixture with a larger parent repository, **When** sharing is tested, **Then** the result reflects the actual candidate behavior; the harness does not initialize Git, remove content, bypass root checks or supply GitHub credentials to hide a failure.
7. **Given** a ready pair on which a feature scenario fails, **When** evidence is collected, **Then** the pair remains available for diagnosis while the scenario is marked failed; readiness alone cannot produce an acceptance pass.

---

### User Story 4 - Update, diagnose and retire a pair predictably (Priority: P2)

The tester can preserve a reproduction, explicitly move the pair to a newer PR
commit, inspect evidence and release the environment. Closing the PR or reaching
the expiry also initiates cleanup.

**Why this priority**: Predictable updates and cleanup prevent misleading results,
interference between runs, leaked access and abandoned infrastructure charges.

**Independent Test**: Advance a PR while a pair is open, verify the existing
candidate remains pinned, explicitly update it, then stop or expire the pair and
verify both computers and their run-scoped access are retired.

**Acceptance Scenarios**:

1. **Given** an active pair at commit A, **When** the PR advances to B, **Then** the report marks the pair outdated without replacing its runtime or desktop code; evidence for A is never presented as acceptance of B.
2. **Given** an explicit update to B, **When** only one computer or the desktop artifact is updated, **Then** the pair is not ready for B; once all components and fresh runtime registrations agree, a new manifest identifies the validated generation and states whether test data was preserved or reset.
3. **Given** cancellation, removal of the pair request, PR close, explicit stop or expiry, **When** cleanup runs, **Then** both test computers, run-created grants, registrations and test data become inaccessible; customer resources, pre-existing fixture identities and unrelated pairs remain untouched.
4. **Given** a provider deletion cannot be confirmed, **When** cleanup is reported, **Then** the pair remains cleanup-pending and its capacity is not reused; bounded reconciliation retries and the unresolved resource are visible.
5. **Given** a failed sharing scenario, **When** the tester opens its report, **Then** evidence identifies the actor role, computer, organization, exact component versions, scenario step and relevant correlated diagnostics without including tokens or private customer content.

### Edge Cases

- An account lease, organization membership or test AI allowance expires during setup or testing.
- The two test accounts share a display name, or the tester signs in with a personal account by mistake.
- A second pair or PR attempts to use an already-leased identity, organization or runtime binding.
- The PR head changes during build, provisioning, desktop download or an explicit update.
- The owner runtime is reachable for health but its collaboration control connection is stale.
- One app's single-instance handling or authentication callback focuses the other app.
- The launcher is interrupted after starting one app; later cleanup must not kill the tester's normal app.
- The selected artifact does not support the local operating system or architecture.
- A test organization disallows member AI prompts, or the configured test allowance is unavailable.
- A candidate can serve the shell but fails inventory, publication, member acceptance or prompt execution.
- A member leaves the organization or has access revoked while a Chat or connection is open.
- A pair request is retried while a previous run is updating or destroying its resources.
- The manifest is copied, altered or reused after the pair generation is retired.
- Cleanup loses its runner or provider connection, or a PR lookup cannot confirm whether it remains open.
- Two active pairs are tested concurrently; selecting one must never switch the other's platform target.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Maintainers MUST be able to request, inspect, explicitly update and stop a pair for an open same-repository PR without merging it, promoting a release channel or modifying any customer computer.
- **FR-002**: Each pair MUST contain exactly two independently owned Preview computers and exactly two distinct dedicated test identities with current membership in one dedicated test organization. Their fixture identities and organization MUST be leased exclusively to that active pair.
- **FR-003**: An additional authenticated outsider identity MUST be available for denial checks without requiring a third computer; it MUST have no membership or inherited access to the test organization.
- **FR-004**: Both installed/running runtimes, matching Electron artifact and candidate platform components MUST identify the requested immutable commit. When a component is intentionally unchanged, its verified build provenance and compatibility MUST be recorded rather than silently assumed.
- **FR-005**: Request admission MUST reuse existing Preview eligibility, approval and capacity rules, account for both computers, and reserve a whole pair or visibly queue it. Forks or unapproved candidates MUST receive no privileged execution or test credentials.
- **FR-006**: Repeated/concurrent requests MUST resolve to one active pair per PR. Partial provisioning MUST never appear ready, silently leak a computer, or release a resource whose deletion is unconfirmed.
- **FR-007**: Readiness MUST require both expected owners, current organization membership, healthy running versions, fresh collaboration registrations/control connections, matching desktop availability and a usable bounded test AI configuration. Missing prerequisites MUST produce a safe, actionable state.
- **FR-008**: The pair handoff MUST be a credential-free manifest naming the run, generation, PR, commit, expected roles, computer identities, organization, trusted connection targets, desktop artifact provenance, readiness and expiry. Possession of a manifest MUST grant no access.
- **FR-009**: One documented local action usable by a tester or Codex MUST open two simultaneous Electron Desktop instances from the manifest with separate persistent test profiles, session stores, computer selections and instance ownership. No personal profile may be reused or overwritten.
- **FR-010**: The launcher MUST verify the handoff and artifact provenance, expected actor/computer bindings and supported local target. It MUST reject tampered, expired, retired, wrong-origin or wrong-commit inputs without falling back to production or another pair.
- **FR-011**: Both Electron apps MUST visibly distinguish owner/member roles and show the expected computer, organization and candidate. Sign-in, sign-out, callbacks, relaunch and profile cleanup MUST preserve independence from each other and the normal app.
- **FR-012**: Test identities MUST authenticate normally. The pair MUST exercise the real membership, owner-runtime session, caller/machine ownership, scope, grant, inventory and Chat authorization boundaries; no shared-machine access list, forged actor, authentication bypass or preaccepted grant may stand in for collaboration.
- **FR-013**: The test journey MUST support fresh sharing-at-creation and sharing-after-creation cases, first-click dialog readiness, explicit publication, pending member acceptance, inherited Chat prompt execution/persistence and outsider denial. Every scenario MUST record actual observed results.
- **FR-014**: The environment MUST support controlled owner restart, reconnect, failed-publication and revocation checks. Failed setup MUST keep a project private, and failure recovery MUST not publish or widen access as a harness workaround.
- **FR-015**: Pair readiness, product acceptance and latest-PR currency MUST be separate report states. A failed candidate journey MUST remain a failure even when both computers are healthy; it MUST remain inspectable until stop or expiry.
- **FR-016**: A new PR commit MUST mark an existing pair outdated without automatic replacement. An explicit update MUST suspend ready status until the pair's component versions agree and MUST declare preserved versus reset test data; previous evidence stays bound to its original commit.
- **FR-017**: An update or reset MUST retire obsolete run capabilities and invalidate stale manifests. Concurrent start/update/stop operations MUST have one authoritative outcome; a late operation MUST not overwrite or revive a newer generation.
- **FR-018**: Preview identity, data, credentials, signing authority and routing MUST stay within the approved test boundary. A pair MUST be pinned to its own candidate target; shared preview routing changes MUST not redirect another active pair. The flow MUST not activate an unfinished hostname or identity migration or grant candidate code production operator credentials.
- **FR-019**: Member prompts MUST use an explicitly bounded test allowance/configuration, without charging a customer balance or exposing personal integration credentials. Missing allowance or incompatible organization policy MUST be reported rather than bypassed or secretly changed.
- **FR-020**: Pair status MUST expose the failed stage and scoped diagnostic access. User-facing failures MUST remain safe; detailed operator diagnostics MUST be bounded, access-controlled and correlated to the exact run, component versions and actor role.
- **FR-021**: Stop, request removal, PR close and expiry MUST initiate idempotent retirement of both computers and run-created data, grants, credentials and registrations. Reconciliation MUST survive interruption. Unconfirmed provider deletion MUST keep cleanup and capacity visibly pending.
- **FR-022**: Cleanup MUST target only resources belonging to the exact pair/generation. It MUST preserve customer resources, other pairs, baseline test accounts/organization configuration and the tester's normal Electron data; explicit local-profile cleanup MUST be limited to the identified pair profiles.
- **FR-023**: The handoff MUST include a repeatable tester guide, per-surface capture instructions and an evidence report naming exact builds, scenario results, transport exercised, real versus simulated boundaries and limitations. Screenshots/recordings MUST be attached or accessibly linked, never committed to the repository; external posting MUST use the approved review workflow.
- **FR-024**: Implementation MUST add fault-detecting tests before behavior changes, preserve the real failing boundaries and make required qualification fail on absent prerequisites, zero scenarios or skipped required assertions. A simulated provider or renderer test MUST not be reported as real VPS, Electron or model acceptance.
- **FR-025**: Delivery MUST update the internal preview/testing guide and include a separate public documentation PR in `FinnaAI/matrix-os-site` describing request, launch, account selection, update, diagnosis, expiry and teardown without private identities or credentials.

### Scope and Assumptions

- V1 is a maintainer-triggered pair request on a PR, with an optional manual rerun, one pair report/manifest and a local dual-Electron launcher. A PR label is the expected entry experience; final naming belongs to planning.
- Each request creates fresh test computers and clean test homes. Reusable dedicated account fixtures are allowed, but they are leased exclusively and contain no customer content. A persistent warm-computer pool is deferred.
- “Without deployment” means no production release, channel promotion, merge or customer update. Installing candidate builds on the two explicitly scoped Preview computers is part of the feature.
- V1 consumes the existing preview desktop artifact targets, declares their operating system/architecture availability, and refuses unsupported targets. At least the requester's actual local target must be qualified before claiming the launcher complete; adding new platform packaging is outside this feature.
- The default hard lifetime is 72 hours, with earlier retirement on explicit stop, request removal or PR close. Re-requesting, restarting or re-registering does not silently extend it. Evidence uses existing access-controlled artifact retention and reports its own expiry.
- A test organization allows the member-prompt scenario using dedicated test settings. Live customer organizations, memberships, grants, existing Shared with me records and personal developer credentials are outside this feature's mutation scope.
- A pair may be environment-ready before the user signs into the two local profiles; local session readiness is checked separately. No identity is impersonated to remove the normal sign-in step.
- A candidate platform build is used when the PR changes platform behavior; otherwise a compatible, verified Preview baseline is explicitly named. Components built from the candidate may not silently use main or another PR instead.
- V1 tests one candidate PR at a time per pair. Native multi-PR integration/stacks, a fully autonomous visual-test agent, mobile launchers and production rollout automation are deferred. Normal branch fixes and human retesting remain supported.
- Review from the collaboration/platform owner, Preview infrastructure owner and Electron Desktop owner is recommended. Recommendations do not add approval gates beyond the existing authorized workflow.

### Authority and Access Expectations

No endpoint design is introduced by this specification. Planning must name the
actual routes and their authentication, validation and resource limits before
implementation. The user-visible authorization contract is:

| Operation or resource | Permitted actor and source of truth | Required denial |
| --- | --- | --- |
| Request/update/stop a pair | Authorized maintainer; authoritative pair ownership, PR eligibility and generation | Outsider, unapproved PR, another run or customer machine |
| Inspect a manifest/report | Authorized tester or operator within that pair's evidence policy | A copied manifest confers no access; no embedded credentials |
| Open computer A or B | Its respective real authenticated test owner and current machine binding | The other account gains no blanket access to its peer's computer |
| Discover/open a shared project | Current organization member with the actual project grant and required acceptance | Nonmember, pending/unaccepted access, revoked or wrong-pair identity |
| Send an inherited Chat prompt | Authenticated, currently authorized project member under owner-runtime and test AI policy | Outsider, stale/revoked authorization or wrong machine/scope |
| Cleanup a run | Trusted lifecycle authority for that exact pair/generation | Customer resources, another pair or baseline fixture identities |

The authoritative pair inventory and current generation govern mutations;
related reservation/lifecycle changes must be atomic and generation-checked.
An acceptable partial state is a visibly failed/cleanup-pending run retaining
its exact owned resources and capacity until reconciliation proves retirement.
It is never an apparently ready or silently orphaned pair. Organization
membership and owner-held project grants remain collaboration authority;
preview discovery and manifests never become substitutes for authorization.

### Input, Resource and Startup Expectations

- Pair requests, manifest fields, artifact references and local profile names must be validated and bounded before use. A requester cannot substitute a customer computer, arbitrary connection/download target, another actor or a path outside the pair's local profile area. Symlink or traversal inputs must not let cleanup escape that area.
- Manifest trust must come from an independently verified first-party source and artifact provenance, not a checksum supplied only by the same untrusted input. Credentials stay in the normal authenticated stores and never travel in the handoff, command arguments, logs or evidence.
- Provisioning, downloads, readiness checks, launch and cleanup have bounded waits and visible timeout states. Resource and retry limits must reuse existing Preview limits where applicable; planning must record the concrete limits before implementation. Logs, diagnostic output, temporary downloads and retained profiles need size/retention bounds and explicit cleanup ownership.
- Startup first verifies request eligibility and leases dedicated identities, then verifies candidate provenance, prepares both computers and their Preview authority, checks fresh runtime enrollment, and publishes the manifest. Normal local sign-in and actor/computer verification precede the user's sharing journey. No fixture grants or successful-sharing claim are prerequisites for environment readiness.
- Cancellation and shutdown must stop only work owned by the run, preserve durable reconciliation for unfinished cloud work, and release capacity only after confirmed retirement. Closing local apps alone must not destroy an active cloud reproduction; that requires an explicit stop or the declared expiry.

### Acceptance and Surface Matrix

| Actor and starting state | Action | Observable completion | Failure/recovery | Authority/data boundary | Surface and required lane |
| --- | --- | --- | --- | --- | --- |
| Maintainer; eligible unmerged PR | Request pair | Two distinct owned computers; common test organization; exact versions and manifest | Retry, queue, partial failure and stale-head handling | Exact PR/pair/generation; customer inventory unchanged | Actual Preview lifecycle qualification |
| Owner/member; ready pair and normal app open | Launch, sign in and relaunch both clients | Two independent candidate sessions; normal app unchanged | Wrong account, callback collision, interrupted launch and stale artifact | Separate local identities, profiles and machine selections | Electron Desktop; actual produced artifact on declared local target |
| Owner; fresh private project | Share at creation, then separate later-share case | First-click dialog, explicit publication, correct sharing indicator | Inventory failure or interrupted setup leaves project private | Real owner runtime, inventory and publication transaction | Electron Desktop plus equivalent Web Desktop capture; real client/service path |
| Member; pending project grant | Discover, open, prompt and reopen | Actual acceptance; inherited Chat response persists on owner computer | Owner restart/reconnect and revoked membership/access | Current membership, project grant, owner-executed prompt and bounded test funding | Electron Desktop and Web Desktop; real two-account journey |
| Outsider; no test-org membership | Open link and attempt prompt | Denial; no owner-side prompt execution | Expired, copied and wrong-pair references also denied | Real authenticated outsider; no blanket preview allowlist | Actual authenticated denial journey |
| Operator; active or partially failed pair | Stop or expire run | Both computers and run access retired; exact cleanup proof | Provider failure/cancellation stays cleanup-pending | Only run-owned resources; baseline identities retained | Real lifecycle plus interrupted/concurrent-operation qualification |

Web Canvas, Web Mobile and Native Mobile receive no new launcher or renderer
flow in V1 and have no acceptance claim from these desktop runs. If implementation
changes a shared runtime/client behavior affecting one of those surfaces, its
surface-specific qualification must be added rather than inferred from Electron
Desktop or Web Desktop. Review evidence follows root repository requirements,
including separately labeled captures and the applicable review-channel record.

### Dependencies and Existing Work

- [Preview environments](../093-preview-environments/spec.md) and the [current collaboration-preview guide](../../docs/dev/preview-environments.md) provide the existing single-home foundation; paired ownership and launching are new work.
- [Per-PR Preview isolation](../530-per-pr-preview-hostnames/spec.md) defines unfinished origin/identity boundaries. This feature must reuse an approved isolated path or explicitly gate on the missing boundary; it must not activate the deferred wildcard route or claim shared staging is fully isolated.
- [Private Preview](../537-private-preview/spec.md) remains owner-only and intentionally disables collaboration; it is not the pair's runtime type.
- [Collaboration authority](../124-organization-collaboration/spec.md) and [sharing UX](../525-collaboration-ux-redesign/spec.md) remain the product source of truth. This feature exposes their candidate behavior without changing permissions to hide defects.
- [Bounded Preview funding](../633-preview-funded-runtime-access/spec.md) and ENG-348 provide the test-execution allowance dependency; source availability is not proof of live activation.
- ENG-325's build/provenance and capacity work should be reused where compatible. A pair consumes capacity for two computers and does not introduce a competing unlimited queue.
- [Testing effectiveness](../../docs/dev/testing-effectiveness.md) governs named-fault coverage, real-boundary qualification, red/green evidence and truthful reporting.

### Key Entities *(include if feature involves data)*

- **Preview pair**: PR, requesting maintainer, immutable candidate, lifecycle, hard expiry, current generation and exactly two owned Preview computers.
- **Pair generation**: One explicitly selected set of component builds and identity/runtime bindings; its evidence cannot qualify another generation.
- **Account fixture lease**: Two distinct real test accounts, their dedicated organization, an optional outsider identity and exclusive active-run ownership; credentials are not part of the manifest.
- **Computer member**: Owner/member role, canonical account and machine identity, installed/running build, runtime connection freshness and readiness result.
- **Pair manifest**: Non-authorizing handoff describing the exact run, safe connection targets, component/artifact provenance, expected identities and expiry.
- **Local preview profile**: One account/computer's independent Electron state and launcher-owned process lifecycle, separate from personal profiles.
- **Acceptance record**: Exact versions, scenario and actor roles, per-surface results, real/simulated boundaries, diagnostics, capture links and evidence expiry.
- **Cleanup record**: Exact run-owned resources, retirement progress, unresolved deletions and capacity retained pending verified cleanup.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From one preview request, at least 9 of 10 qualification attempts with prerequisites available provide two usable candidate computers and a matching desktop handoff within 30 minutes after admission. Queue time is reported separately; zero customer computers or channel pointers change.
- **SC-002**: After initial account sign-in and artifact download, one local action opens both correctly labeled, independent candidate sessions within two minutes on each advertised qualified local target; a concurrently running normal session remains unchanged.
- **SC-003**: In 10 repeated or concurrent requests for the same PR, exactly one active pair exists, with two distinct owners and no duplicate billable computer or concurrently reused identity lease.
- **SC-004**: A tester can complete and record first-share, member open, persisted inherited-Chat response and outsider-denial observations within 15 minutes once the pair is ready and signed in. A failing candidate produces a recorded failed step with scoped diagnostics instead of an acceptance pass.
- **SC-005**: Every qualification result names the exact tested candidate and component versions. Across all stale-head, wrong-account, wrong-artifact and wrong-pair cases, zero results claim acceptance of a different candidate or actor.
- **SC-006**: Across all interruption and injected partial-failure cases, no incomplete pair is marked ready and no unconfirmed deletion is reported complete or releases its occupied capacity.
- **SC-007**: Access is retired within 15 minutes of a stop, PR-close or hard-expiry event under normal provider availability, and resource deletion is confirmed within 30 minutes. Provider failures remain visible until reconciliation confirms cleanup; 100% of cleanup attempts preserve customer resources and unrelated local profiles.
- **SC-008**: All required manual journeys have separate Electron Desktop and Web Desktop evidence and an explicit pass/fail/not-run result. No missing prerequisite, skipped required assertion, synthetic renderer or healthy-computer status is counted as live collaboration acceptance.
