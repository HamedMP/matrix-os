# Feature Specification: Developer Fast Path

**Feature Branch**: `097-developer-fast-path`  
**Created**: 2026-06-16  
**Status**: Draft  
**Input**: User description: "Focus Matrix OS on the developer use case by simplifying onboarding, removing distracting surfaces, creating an agent-first signup/setup path, adding a default Developer mode beside Canvas, showing Terminal first and Symphony second, making Terminal one canonical surface, removing Workspace, securing developer SSH keys through an explicit vault/unlock model, and using warm cloud runtimes to reduce provisioning waits."

**Related Architecture Work**: `specs/093-codebase-domain-structure/` defines the domain-structure convention and gateway migration strategy. For this feature, 093 is an enabling cleanup track, not a prerequisite for product work. Land the 093 docs/lint foundation before or alongside 097, but defer high-coupling gateway moves until Developer mode, Workspace removal, Terminal-first setup, SSH credentials, and warm-pool flows settle.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent-Guided First Coding Session (Priority: P1)

A developer copies one Matrix setup prompt into their existing coding agent. The agent installs or verifies the Matrix CLI, opens the hosted signup/device flow for the human to approve, guides checkout, waits for the Matrix computer to become ready, opens one persistent terminal session, helps the user authenticate GitHub inside that session, clones the requested repository, and starts the user's preferred coding agent inside Matrix.

**Why this priority**: This is the core developer acquisition loop. If an external agent can get a developer from curiosity to a working remote coding environment, Matrix becomes useful before the user learns the rest of the OS.

**Independent Test**: Can be tested by giving the setup prompt to a supported local coding agent on a clean laptop profile and measuring whether the user reaches a remote Matrix terminal running their preferred coding agent against a cloned repository.

**Acceptance Scenarios**:

1. **Given** a developer with no Matrix account, **When** they paste the setup prompt into a local coding agent and approve the required browser/device prompts, **Then** the agent guides them to a ready Matrix computer with a cloned repository and an authenticated coding agent running in a persistent terminal session.
2. **Given** a developer already signed in but without a Matrix computer, **When** the agent runs the setup flow, **Then** Matrix resumes from the existing account state, completes checkout/provisioning guidance, and does not force the user to repeat account creation.
3. **Given** GitHub or the preferred coding agent requires browser authorization, **When** authorization is needed, **Then** the Matrix terminal clearly shows the authorization command and the local agent tells the human exactly which browser approval to complete.
4. **Given** setup is interrupted, **When** the developer reruns the same prompt or reattaches to the setup session, **Then** setup resumes from the last completed step without creating duplicate computers or losing terminal context.

---

### User Story 2 - Default Developer Mode (Priority: P1)

A developer who signs in through the web lands in a normal SaaS-style Developer mode beside Canvas. Developer mode has a persistent sidebar and step list, opens with Terminal as the primary surface, and presents Symphony as the next developer app after terminal setup. The dashboard shows account, checkout, computer readiness, GitHub/SSH, repository, and coding-agent steps beside clear primary actions. Canvas remains available as a switchable workspace, but the default product posture is terminal-first developer setup.

**Why this priority**: Developers need predictable progress and copyable commands more than immersive onboarding. A Developer mode makes the flow legible, terminal-first, and compatible with both human-led and agent-led setup.

**Independent Test**: Can be tested by signing up through the hosted web flow and verifying the user lands in Developer mode, sees Terminal first, sees Symphony as the secondary developer app, can copy the agent setup prompt, can launch the single terminal surface, and can switch to Canvas only after the developer basics are complete or explicitly skipped.

**Acceptance Scenarios**:

1. **Given** a new web user after account creation, **When** the user reaches Matrix onboarding, **Then** they land in Developer mode with a sidebar checklist, current setup status, primary next action, copyable agent setup prompt, Terminal as the primary surface, and Symphony visible as the secondary developer app.
2. **Given** a user has completed checkout and runtime assignment, **When** the runtime is still starting, **Then** the dashboard shows progress and keeps the user on useful instructions instead of a blank loading wall.
3. **Given** a user wants a visual workspace, **When** they switch modes, **Then** Canvas is available without replacing Developer mode as the default first-run surface.

---

### User Story 3 - Secure GitHub SSH Setup (Priority: P1)

A developer needs repository access inside Matrix without copying private keys from their laptop or leaving broad credentials unmanaged on the cloud computer. Matrix guides the user to create a Matrix-specific SSH key for the selected project, register only the public key with GitHub, store the private key securely inside the owner's runtime, and load it into the session only after explicit approval. Users may enable a passwordless/trusted-runtime mode later, but it is never the default and remains revocable.

**Why this priority**: Cloud coding is only credible if source access is safe. Developers should not paste private keys into terminals, agents should not upload local secrets, and long-running agents need a clear, auditable path to use Git credentials.

**Independent Test**: Can be tested by onboarding a new repository with no existing Matrix SSH key and verifying Matrix creates a scoped key, registers or displays the public key for GitHub, keeps the private key inside the runtime, requires user approval before loading it, and can revoke/rotate it.

**Acceptance Scenarios**:

1. **Given** a developer selects a GitHub repository with no Matrix SSH key, **When** they choose secure SSH setup, **Then** Matrix creates a dedicated Matrix key for that repository or account, shows/registers only the public key, and never asks for the user's local private key.
2. **Given** the key is encrypted or locked, **When** an agent needs to clone or push, **Then** Matrix asks the user to approve unlocking the key for a bounded session before loading it into the remote SSH agent.
3. **Given** the user enables passwordless trusted-runtime access, **When** Matrix records the choice, **Then** the UI explains the risk, requires recent user reauthentication, stores an audit event, and provides one-click revoke/rotate.
4. **Given** a project is removed or compromised, **When** the user revokes the Matrix SSH key, **Then** future Git operations fail until a new key is approved and registered.

---

### User Story 4 - Warm Runtime Allocation (Priority: P1)

Matrix keeps a small pool of warm, unassigned cloud computers with the current bundle already downloaded and installed. When a developer signs up and completes checkout, Matrix assigns a warm computer when available, finishes user binding, and avoids the long cold-provisioning wait. If a started signup is abandoned and no user claims the warm resource within one hour, Matrix tears it down to control cost.

**Why this priority**: The first-use wait is one of the highest-friction moments. Reducing time-to-ready directly improves activation while preserving the VPS-native architecture.

**Independent Test**: Can be tested by maintaining at least one warm unassigned computer, completing signup/checkout, verifying assignment from the warm pool, and verifying abandoned warm resources are cleaned up after the one-hour window.

**Acceptance Scenarios**:

1. **Given** a warm unassigned computer exists, **When** a new paid signup reaches computer creation, **Then** Matrix assigns the warm computer instead of starting a cold build and shows the user a shorter readiness path.
2. **Given** the warm pool is empty, **When** a new signup reaches computer creation, **Then** Matrix falls back to cold provisioning and communicates the longer wait clearly.
3. **Given** a warm or pending signup resource remains unclaimed for one hour, **When** the cleanup window expires, **Then** Matrix tears down the resource unless it has been assigned to an active user.
4. **Given** a warm computer has not yet been assigned, **When** it is inspected, **Then** it contains no user identity, no user secrets, no GitHub credentials, and no coding-agent credentials.

---

### User Story 5 - Product Surface Reduction for Developer Quality (Priority: P2)

A developer sees a focused Matrix OS that only exposes the surfaces needed for cloud coding: Developer mode, Canvas, Terminal, Symphony, Chat, Files, Preview/App Preview, and CLI. Voice/Aoede onboarding, goal picker, consumer default apps, broad integration onboarding, and Workspace are removed from the first developer product.

**Why this priority**: Shipping fewer surfaces improves quality, testability, supportability, and user comprehension. The removed surfaces can return later only if they support the developer loop.

**Independent Test**: Can be tested by entering Matrix as a new developer and verifying removed capabilities do not appear in onboarding, launchers, command palette, default dock/sidebar, or docs for the primary setup path.

**Acceptance Scenarios**:

1. **Given** a new developer enters onboarding, **When** they view available setup options, **Then** they are not offered voice/Aoede onboarding, app-building/company-brain/assistant goal choices, or broad integration setup.
2. **Given** a new developer enters the shell, **When** they open launcher or command palette, **Then** consumer default apps and games are absent from the default developer experience.
3. **Given** a user previously had Workspace references saved, **When** they load Matrix after this change, **Then** Workspace does not open and the user is routed to supported developer surfaces without a broken window.
4. **Given** Symphony is available, **When** a developer has completed the basic terminal/GitHub/repo/agent path, **Then** Symphony can be introduced as a next step rather than a prerequisite.

### Edge Cases

- Warm pool capacity is exhausted during a signup spike.
- Checkout succeeds but webhook or entitlement confirmation is delayed.
- User abandons after account creation but before checkout.
- User abandons after checkout but before first runtime access.
- A warm runtime fails health checks before assignment.
- A user retries setup while a previous computer assignment is in progress.
- GitHub browser auth or coding-agent browser auth is denied, expires, or requires reattempt.
- SSH key creation succeeds but GitHub public-key registration fails.
- SSH key unlock expires while a long-running agent is still working.
- A user enables passwordless trusted-runtime access and later needs emergency revocation.
- A local agent runs the setup prompt but cannot open a browser automatically.
- Existing users have persisted Workspace windows, default app pins, or onboarding completion state from the old product.
- Mobile-sized browsers reach onboarding before mobile developer support is considered production-ready.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix MUST provide a Developer mode beside Canvas and make Developer mode the default first-run mode for the developer MVP.
- **FR-002**: Developer mode MUST present a conventional dashboard with a sidebar checklist, status summary, current next action, and copyable commands.
- **FR-003**: Developer mode MUST show Terminal as the primary surface and Symphony as the secondary developer app once the runtime is available.
- **FR-004**: Matrix MUST make the agent-first setup prompt a primary onboarding artifact for both website documentation and in-product onboarding.
- **FR-005**: The agent-first prompt MUST guide an external coding agent through CLI installation/verification, account/device approval, checkout guidance, runtime readiness polling, secure GitHub/SSH setup inside Matrix, repository clone, and preferred coding-agent authentication inside Matrix.
- **FR-006**: Matrix MUST preserve resumability for setup steps so repeating the prompt or command continues from the current account/runtime/session state instead of creating duplicate resources.
- **FR-007**: Matrix MUST hide advanced power, plan, and region choices from the default first-run path unless an advanced option is explicitly opened.
- **FR-008**: Matrix MUST expose exactly one canonical Terminal surface in the product shell for the developer MVP. Multiple sessions may exist later, but they must be accessed through the same canonical Terminal surface rather than separate terminal-like apps or Workspace surfaces.
- **FR-009**: Matrix MUST remove Workspace from the developer MVP surface, including onboarding, launcher, command palette, default pins, primary documentation, and saved-window restore behavior.
- **FR-010**: Matrix MUST drop voice/Aoede onboarding from the developer MVP path.
- **FR-011**: Matrix MUST drop onboarding goal choices for app building, company brain, and assistant workflows from the developer MVP path.
- **FR-012**: Matrix MUST drop consumer default apps and games from the default developer launcher/dock/sidebar experience.
- **FR-013**: Matrix MUST drop broad app/integration setup from onboarding; GitHub and coding-agent authentication remain explicit developer setup steps performed inside the Matrix terminal unless a future focused integration replaces them.
- **FR-014**: Matrix MUST keep Chat, Files, Preview/App Preview, CLI, and Canvas available as developer support surfaces without making them compete with Terminal and Symphony for initial attention.
- **FR-015**: Symphony MUST be visible in Developer mode as the second developer app, but it MUST NOT block the initial coding-ready state.
- **FR-016**: Matrix MUST create or guide creation of Matrix-specific SSH keys for GitHub access instead of asking users or agents to copy local private keys into Matrix.
- **FR-017**: Matrix MUST store developer SSH private keys only inside the owner's Matrix runtime or owner-controlled secret store, and MUST keep private keys encrypted or locked at rest by default.
- **FR-018**: Matrix MUST require explicit user approval before loading a locked SSH key into an agent-accessible session, with a bounded unlock duration.
- **FR-019**: Matrix MAY offer passwordless trusted-runtime access only as an explicit opt-in with recent user reauthentication, clear risk disclosure, audit logging, and revoke/rotate controls.
- **FR-020**: Matrix MUST support revocation and rotation of Matrix-managed SSH keys without requiring users to manually search hidden files.
- **FR-021**: Matrix MUST NOT rely on GitHub CLI's optional-passphrase SSH key generation for the secure path; GitHub account authorization and SSH key creation MUST be separate steps unless Matrix can verify the created key is encrypted or vault-protected.
- **FR-022**: Matrix MUST maintain a warm pool of unassigned computers with the current runtime bundle prepared, subject to configured capacity and cost limits.
- **FR-023**: Warm computers MUST NOT contain user identity, user data, GitHub credentials, SSH private keys, coding-agent credentials, or integration secrets before assignment.
- **FR-024**: Matrix MUST assign a warm computer to an eligible new user when one is healthy and available; otherwise it MUST fall back to cold provisioning with clear progress messaging.
- **FR-025**: Matrix MUST tear down unassigned or abandoned warm/pending signup resources after one hour unless they have become owned by an active user.
- **FR-026**: Matrix MUST record warm-pool and credential lifecycle events in an operator-visible audit trail without exposing provider details, raw infrastructure errors, or secret material to end users.
- **FR-027**: Matrix MUST provide a safe migration for users who have old onboarding, Workspace, consumer app, or default pin state so the simplified developer shell opens without broken references.
- **FR-028**: Matrix documentation MUST present the developer fast path as the primary quickstart and move removed/deferred capabilities out of the main path.

### Security Architecture

#### Auth Matrix

| Surface | User/Actor | Required Authorization | Notes |
| --- | --- | --- | --- |
| Developer onboarding dashboard | Signed-in user | Own account and own runtime state only | Shows coarse setup status and safe next actions. |
| Agent-first setup prompt | Local coding agent acting for user | Human approval for account, checkout, SSH/GitHub setup, and coding-agent auth | Prompt must not ask the agent to collect or upload local secrets. |
| CLI setup/login | Authenticated user or pending device approval | Own account and own runtime only | Device approval remains human-controlled. |
| SSH key vault/unlock | Runtime owner | Recent user approval or explicit trusted-runtime opt-in | Private keys never leave the owner-controlled runtime/secret store. |
| Warm pool creation | Platform/operator automation | Platform-owned warm-pool policy | Not user-addressable directly. |
| Warm pool assignment | Entitled signed-in user | One runtime assignment per eligible user/slot | Must be idempotent to avoid duplicate computers. |
| Warm pool cleanup | Platform/operator automation | Platform-owned cleanup policy | Must never delete an active owned runtime. |
| Shell Terminal | Runtime owner | Own runtime sessions only | Single canonical surface; session access remains owner-scoped. |

#### Input Validation and Error Policy

- All user-supplied handles, return paths, repository URLs, setup state identifiers, runtime IDs, and terminal session names MUST be validated at the boundary before use.
- Repository clone guidance MUST prefer user-confirmed repository URLs and must not silently clone arbitrary agent-provided URLs without showing the target to the user.
- SSH key setup MUST display the key scope, target account/repository, unlock duration, and whether the key is encrypted, locked, or trusted-runtime enabled.
- SSH public-key registration MUST send or display public keys only; private keys, passphrases, unlock tokens, and recovery material MUST never be logged, sent to the platform, or shown to local coding agents.
- GitHub CLI usage MUST avoid optional-passphrase generated SSH keys in the secure path; the setup flow should authenticate the GitHub account first, then create/register a Matrix-managed SSH key with enforced encryption or vault protection.
- Client-facing errors MUST be generic and actionable; provider names, raw infrastructure errors, filesystem paths, billing internals, and credential status details MUST stay in server/operator logs.
- Webhook, checkout, and runtime-assignment flows MUST be idempotent so retries cannot create duplicate computers or duplicate ownership records.

#### Resource Management and Cleanup

- Warm pool size MUST have an explicit cap, replenishment policy, and cost ceiling.
- Warm computers MUST have health checks before assignment.
- Unassigned warm computers MUST be periodically swept and either kept healthy within policy or destroyed.
- Pending signup resources MUST be destroyed after one hour if they remain unclaimed and unowned.
- Cleanup MUST be safe against races with assignment; an assignment in progress wins over cleanup only after ownership is durably recorded.
- Terminal sessions, setup sessions, and onboarding status caches MUST have existing or new caps/TTL behavior documented in the implementation plan.

#### Failure Modes

- If warm assignment fails, the user remains in onboarding dashboard with a safe retry/cold-provision path.
- If payment confirmation is delayed, the user sees a payment-settling state with support guidance rather than terminal access.
- If runtime health fails after assignment, Matrix retries or replaces the runtime without exposing provider details.
- If SSH/GitHub or coding-agent auth fails, the setup checklist remains incomplete and offers a retry command without deleting cloned work or terminal history.
- If an SSH unlock expires during a long-running agent task, Matrix pauses Git operations that require the key and asks for reapproval rather than silently extending access.
- If removed Workspace state exists, Matrix ignores or migrates the reference and logs a recoverable event.

### Key Entities *(include if feature involves data)*

- **Developer Onboarding State**: The user's progress through account, checkout, runtime readiness, terminal readiness, GitHub authentication, repository selection, and coding-agent authentication.
- **Agent Setup Prompt**: The copyable instruction block that a user gives to a local coding agent; includes safe boundaries and expected commands.
- **Developer Mode**: The default first-run mode beside Canvas, optimized around Terminal, setup steps, and Symphony.
- **SSH Key Vault**: Owner-controlled storage and unlock policy for Matrix-managed SSH private keys.
- **Trusted Runtime Credential Mode**: Optional passwordless mode that keeps a Matrix runtime able to use selected credentials after explicit user opt-in and audit logging.
- **Warm Computer**: An unassigned cloud runtime prepared with the current Matrix bundle and no user-owned data or secrets.
- **Runtime Assignment**: The durable binding between one entitled user and one Matrix computer.
- **Setup Terminal Session**: The canonical persistent terminal context used for GitHub auth, repository clone, and coding-agent auth.
- **Deferred Surface Registry**: The list of surfaces intentionally removed or hidden from the developer MVP path, including voice/Aoede onboarding, non-coding goals, consumer apps/games, broad integrations, and Workspace.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 80% of new developer signups with a healthy warm computer available reach a ready Matrix computer within 5 minutes after checkout completion.
- **SC-002**: At least 90% of new developer signups see actionable Developer mode or agent prompt within 10 seconds of completing account authentication.
- **SC-003**: A new developer can reach a cloned repository and running preferred coding agent with no more than four human decisions after account creation: plan approval, checkout approval, GitHub approval, and coding-agent approval.
- **SC-004**: At least 70% of test users following the copied agent prompt complete GitHub authentication, repository clone, and coding-agent launch without needing support intervention.
- **SC-005**: No unassigned or abandoned warm/pending signup computer remains running more than 75 minutes after it becomes unclaimed, allowing a 15-minute sweep grace period beyond the one-hour policy.
- **SC-006**: New developer shell launch shows no voice/Aoede onboarding, goal picker, consumer app/game launcher entries, broad integration onboarding, or Workspace entry points in the default path.
- **SC-007**: Existing users with old Workspace or default-app state can open the simplified shell without broken windows, blank launchers, or unrecoverable errors.
- **SC-008**: User-facing setup errors are actionable and generic in 100% of tested billing, runtime, warm-pool, GitHub, and coding-agent failure scenarios.
- **SC-009**: In 100% of tested secure SSH setup flows, no local private key is uploaded to Matrix and no Matrix-managed private key leaves the owner-controlled runtime or secret store.
- **SC-010**: At least 90% of test users can revoke or rotate a Matrix-managed SSH key in under 2 minutes from the developer setup surface.
- **SC-011**: In 100% of tested secure GitHub setup flows, SSH keys created during onboarding are encrypted, locked, or vault-protected before they can be used by an agent.

## Assumptions

- The developer ICP is the primary launch target for this cut; non-developer consumer OS breadth is explicitly deferred.
- A single recommended hosted runtime profile is acceptable for first-run, with advanced plan/region selection available only outside the default flow.
- GitHub authentication remains `gh auth login` inside the Matrix runtime for this MVP, supplemented by Matrix-managed SSH key generation for repository access.
- Preferred coding-agent authentication remains owned by each coding-agent CLI inside the Matrix runtime for this MVP.
- Warm computers may be unassigned and reusable only before any user identity, user data, or secrets are written; once assignment begins, failed or abandoned resources are destroyed rather than reassigned.
- Developer mode is the default first-run and near-term default shell mode for developers; Canvas remains switchable and becomes the future Miro-like coding canvas for Symphony and multiple terminal views.

## Explicitly Deferred or Removed From Developer MVP

- Voice/Aoede onboarding.
- Onboarding goal picker for app building, company brain, and assistant workflows.
- Consumer default apps and games in the default developer launcher/dock/sidebar.
- Broad app/integration ecosystem setup during onboarding.
- Workspace as a shell surface and onboarding concept.
- Native/mobile-first developer parity.
- Multiple terminal surfaces in the shell. Future multiple terminal views belong in the Canvas coding model with Symphony, not in separate products.
- Making Symphony a prerequisite for initial coding readiness.

## Implementation-Agent Prompt

Use this prompt for a coding agent that will implement the 097 developer-focus work while respecting the 093 architecture track:

```text
You are implementing Matrix OS Spec 097: Developer Fast Path.

Context:
- Work in a manual git worktree from latest origin/main. Do not work directly on main.
- Read specs/097-developer-fast-path/spec.md and specs/097-developer-fast-path/plan.md first.
- Also read specs/093-codebase-domain-structure/spec.md, domain-convention.md, and gateway-domain-map.md if present or fetch branch origin/093-codebase-domain-structure.
- 093 is relevant for architecture discipline, but do not run broad gateway file-move migrations as part of 097.

Product target:
- Make Developer mode the default near-term shell/onboarding mode beside Canvas.
- Developer mode should be a normal SaaS dashboard/sidebar experience.
- Show Terminal as the primary surface and Symphony as the secondary developer app.
- Keep one canonical Terminal surface; sessions live inside that surface.
- Remove or hide Workspace from onboarding, launcher/default pins, command palette, docs, saved restore, and developer MVP flows.
- Remove or hide Voice/Aoede onboarding, goal picker, consumer default apps/games, and broad integration onboarding from the developer path.
- Make the copied agent-first setup prompt primary in docs and onboarding.
- Secure GitHub/SSH setup: do not ask users or agents to upload local private keys. Do not rely on gh auth login's optional-passphrase key generation. Authenticate GitHub separately, then generate/register a Matrix-managed SSH key with enforced encryption/vault/approval semantics.
- Add warm runtime pool behavior only with explicit caps, health checks, one-hour abandonment cleanup, idempotent assignment, no user secrets before assignment, and generic user-facing errors.

Relationship to 093:
- You may land 093 PR 1 first or in parallel: gateway ARCHITECTURE.md, DOMAIN.md convention, and check:patterns boundary rule.
- Do not move high-coupling gateway files before 097 lands: workspace, sessions, apps, files, identity, terminal/zellij-adjacent files, onboarding routes, SSH credential code, or warm-pool assignment code.
- If you touch gateway architecture during 097, keep changes local and minimal; record any new domain placement decisions for a future 093 map refresh. Likely future domains include terminal, credentials, and developer/onboarding.

Implementation rules:
- Use TDD: write failing tests first for each behavior change.
- Keep PRs small and independently shippable.
- For React changes, run npx react-doctor@latest shell and fix changed-file findings.
- Run bun run check:patterns, bun run typecheck, and targeted tests; run broader tests when practical.
- Frontend-facing changes require screenshot or short recording evidence.
- Do not expose raw provider, filesystem, database, or infrastructure errors to users.
- Do not add unbounded in-memory maps/sets, fetches without timeouts, or mutating endpoints without body limits.

Suggested PR sequence:
1. 093 foundation PR, if not already landed: docs + check:patterns boundary rule only; no file moves.
2. 097 docs/public prompt PR: primary quickstart and in-product copy for agent-first setup.
3. Developer mode shell PR: default mode, Terminal-first layout, Symphony secondary app, Canvas switcher.
4. Surface pruning PR: hide/remove Workspace, Voice/Aoede, goal picker, consumer apps/games, broad integration onboarding from default developer path; migrate old saved references safely.
5. Secure SSH/GitHub PR: Matrix-managed SSH key creation/registration, unlock TTL, revoke/rotate, trusted-runtime opt-in.
6. Warm runtime pool PR: capped warm pool, health checks, idempotent assignment, one-hour cleanup, audit events.
7. End-to-end validation PR: signup -> checkout -> ready runtime -> Terminal -> secure GitHub/SSH -> clone -> coding-agent login -> Symphony visibility.

Stop and ask before changing product direction if you find a conflict between 097 and existing desktop/Operator code. Prefer adapting the shell/onboarding path to Developer mode over expanding old Workspace/consumer surfaces.
```
