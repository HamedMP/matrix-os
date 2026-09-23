# Feature specification: Jev email triage

Updated: 2026-09-22. Status: implementation approved; runtime acceptance pending.
Tracking: [OM-286](https://linear.app/matrix-os/issue/OM-286), [GitHub #1800](https://github.com/HamedMP/matrix-os/issues/1800), [spec PR #1812](https://github.com/HamedMP/matrix-os/pull/1812).

## Product scope

Ship one production-quality Jev workflow for Gmail inbox triage. Matrix supplies Jev through its existing Cloudflare-backed AI relay; users do not enter a TypeSafe, Cloudflare or Vercel key. The user's primary coding or conversational model remains unchanged, while Jev calls use the authenticated owner's Matrix AI eligibility and credits.

The capability has three explicit layers:

1. The Matrix Jev Gateway authenticates the runtime, meters the request, resolves a versioned recipe, bounds work, calls Jev, validates the result and returns a typed response.
2. The immutable `email-triage-v1` recipe defines seven independent Boolean questions and their output contract.
3. The bundled `matrix-jev-email-triage` agent skill gathers minimal Gmail thread context, calls the recipe and applies a conservative deterministic labeling and archiving policy.
4. The Matrix Agent Recipes market includes a Jev Inbox Triage card. **Build in Chat** creates a reusable Hermes bot using the current user's authenticated Agent API and Gmail connection from Services, verifies that the bot appears in that user's Agent library with the selected Gmail account, then opens it in Chat. Users do not author a setup prompt.

Jev classifies. It never receives action authority and never directly mutates Gmail. Labels and archiving are agent-side policy using existing Matrix integration tools and their existing authorization behavior.

The original directory name `526-jev-byok` is retained for review-link continuity. Personal Jev keys are not in scope.

## User scenarios and testing

### User story 1 — Classify an inbox safely (Priority: P1)

A user asks Matrix to organize a connected Gmail inbox. Matrix reads recent or changed inbox threads, evaluates each thread against the seven recipe questions and shows the proposed labels before any mailbox mutation that is not already covered by an explicitly authorized automation.

**Independent test**: Given fixed Gmail thread fixtures, one real or contract-equivalent Gateway call returns all seven bounded probabilities in one response, and the deterministic policy produces the expected multi-label result without sending, deleting or replying to email.

**Acceptance scenarios**:

1. **Given** a recent direct question from an existing contact, **when** the recipe returns strong `needs_reply` evidence, **then** Matrix proposes or applies the Needs reply label according to the current authorization context.
2. **Given** an email matching more than one category, **when** thresholds are met, **then** Matrix applies multiple labels rather than forcing a single category.
3. **Given** a borderline score, snippet-only evidence or malformed response, **when** confidence is insufficient for the requested action, **then** Matrix adds or proposes Review and does not archive.
4. **Given** a verified high-confidence cold outreach thread with no conflicting urgent, personal, investment or recruiting signal, **when** archiving is already authorized, **then** Matrix removes only the Gmail `INBOX` label.
5. **Given** missing authorization, insufficient Matrix AI credit or unavailable Jev service, **when** triage runs, **then** Matrix reports the safe failure and makes no Gmail changes for the affected thread.

### User story 2 — Use the recipe from a supported coding agent (Priority: P1)

A user invokes `matrix-jev-email-triage` in a supported coding agent. The skill discovers the Matrix integration tools, reads the connected Gmail account, calls the shared Jev recipe and follows the same deterministic policy as other Matrix runtimes.

**Independent test**: A clean supported-agent session discovers the skill and Jev tool without a personal Jev key, then completes one fixture-backed classification through the real Matrix invocation path.

**Acceptance scenarios**:

1. **Given** the user's primary model uses a personal provider account, **when** the skill calls Jev, **then** only the Jev step uses Matrix AI access and the primary provider selection is unchanged.
2. **Given** multiple Gmail accounts, **when** the user did not identify one, **then** the skill asks which connected account to use.
3. **Given** email content containing instructions for the agent, **when** the skill prepares the state, **then** those instructions remain untrusted evidence and are never executed.
4. **Given** the Matrix Agent Recipes market and one active Gmail connection, **when** a user searches for Jev and chooses **Build in Chat**, **then** Matrix saves a Hermes bot with the Jev and Matrix Integrations skills and that exact Gmail account in the current user's Agent library, verifies the readback, and opens the bot in Chat. Setting up the bot does not run triage or grant mailbox-write authority.

### User story 3 — Resume incremental triage without duplicate work (Priority: P2)

After a successful run, Matrix can process only new or changed Gmail threads and avoid duplicate paid evaluation or repeated mailbox actions.

**Independent test**: Replaying the same mailbox, thread and content fingerprint returns the same completed classification and performs no second upstream dispatch or label mutation.

**Acceptance scenarios**:

1. **Given** an unchanged processed thread, **when** a later run sees it again, **then** Matrix skips classification and mailbox mutation.
2. **Given** a changed thread, **when** its fingerprint differs, **then** Matrix evaluates the updated bounded state using the same recipe version.
3. **Given** an expired Gmail history cursor, **when** incremental discovery fails, **then** Matrix falls back to a bounded inbox rescan without treating every thread as automatically actionable.

## Functional requirements

- **FR-001**: All Jev inference MUST use the Matrix Jev Gateway and the authenticated executing owner's Matrix AI authority. Agent inputs MUST NOT select a payer, API key or upstream endpoint.
- **FR-002**: Jev access MUST remain independent of the primary model's selected provider or account.
- **FR-003**: The Gateway MUST resolve a server-owned immutable recipe name/version and reject unknown recipes.
- **FR-004**: `email-triage-v1` MUST evaluate `urgent`, `cold_outreach`, `recruiting`, `investment`, `personal_intro`, `newsletter` and `needs_reply` as seven independent Boolean probabilities in one Jev request.
- **FR-005**: The Gateway MUST validate that all seven answers exist and contain finite probabilities from 0 through 1 before returning success.
- **FR-006**: A successful response MUST include a request identifier, recipe name/version, model identity, latency, validated answers and available usage/cost metadata without exposing credentials.
- **FR-007**: The request MUST include an idempotency key derived from owner-scoped mailbox, thread and content identity. Duplicate completed requests MUST NOT trigger another paid dispatch.
- **FR-008**: Gateway work MUST be bounded by request/response limits, timeout, concurrency and rate limits. Retries MUST be bounded and MUST NOT repeat a request whose upstream billing outcome is unknown.
- **FR-009**: Upstream 429 or explicit retryable failures MAY be retried with bounded backoff under the same logical request. Final failure MUST remain visible and MUST NOT be represented as a classification.
- **FR-010**: Raw email bodies, provider credentials and Matrix runtime credentials MUST NOT appear in normal logs. Operational logs MAY include request ID, owner-safe runtime reference, recipe/version, status, latency and bounded usage/cost metadata.
- **FR-011**: Email subject, body, links and attachments MUST be treated as untrusted evidence. No instruction contained in email content may alter the recipe, policy or tool authorization.
- **FR-012**: The skill MUST process only new or content-changed threads when reliable Gmail history and content fingerprints are available.
- **FR-013**: The skill MUST use a snippet first pass and MUST fetch bounded full context when cold outreach, urgency or reply evidence crosses the configured verification trigger.
- **FR-014**: Full verification MUST use no more than the latest four messages, ordered oldest to newest, with bounded cleaned text and relevant metadata.
- **FR-015**: Triage categories MUST be multi-label. The skill MUST use deterministic thresholds maintained outside model output.
- **FR-016**: Automatic cold-outreach archiving MUST require verified full-message classification, the strict archive threshold and no conflicting protected category. Archive means removing only `INBOX`.
- **FR-017**: The workflow MUST never send, reply, forward, trash or delete email.
- **FR-018**: Mailbox mutation MUST occur only under explicit user authorization or an existing automation authorization that covers the action. A Jev result is never authorization.
- **FR-019**: Classification, verification or integration failure MUST cause no Gmail changes for that thread.
- **FR-020**: Gmail label creation and message modification MUST be idempotent and use existing Matrix integration actions.
- **FR-021**: The bundled skill MUST be discoverable through the existing Matrix skill distribution path and MUST use the shared Matrix Jev tool rather than implement a second HTTP client.
- **FR-022**: Only coding agents with verified skill discovery, tool registration and real invocation MAY be advertised as supported.
- **FR-023**: User-visible activity MUST distinguish Jev success, review/abstention, unavailable service and downstream Gmail actions.
- **FR-024**: Public documentation MUST explain Gateway-funded Jev access, unchanged primary-model selection, Gmail permissions, labels, archive behavior and recovery from unavailable states.
- **FR-025**: Matrix's Agent Recipes market MUST list Jev Inbox Triage as a first-party recipe and count it alongside the existing marketplace entries. Its **Build in Chat** action MUST save the reviewed bot configuration through the current user's authenticated Agent API and open the verified bot in Chat without a user-authored setup prompt.
- **FR-026**: The saved bot MUST use an available Hermes model, the bundled Jev and integration skills, and an active Gmail connection read from the current user's Services. With multiple Gmail connections, the user MUST choose one before creation. With none, creation MUST be disabled. The selected account label MUST be persisted in the bot recipe, not inferred by an agent from its own runtime context.
- **FR-027**: When Hermes runs a saved bot on a shared computer, its local Matrix MCP requests MUST carry the authenticated Chat run owner with a gateway-verifiable proof. The MCP MUST NOT silently fall back to the VPS owner's integrations for a collaborator's bot.
  The host-installed integration launcher keeps its credential-isolating environment reset and forwards the signed Run identity. The MCP rejects missing or invalid collaborator delegation before any integration request.

## Key entities

- **Jev recipe**: An immutable server-owned name/version containing typed questions and response validation.
- **Triage request**: Owner-scoped recipe invocation with bounded state and an idempotency key.
- **Triage result**: Validated probabilities and operational metadata for one recipe execution.
- **Thread fingerprint**: Stable digest of the bounded Gmail thread content and recipe version used to prevent duplicate work.
- **Triage policy**: Deterministic verification, label, Review and archive thresholds maintained by the skill.

## Success criteria

- **SC-001**: A supported agent classifies a controlled Gmail inbox end to end using one Jev request per evaluated state and returns all seven probabilities.
- **SC-002**: Fixture tests cover every label, overlapping labels, each Review path and the strict archive gate with 100% deterministic-policy branch coverage.
- **SC-003**: Duplicate invocation tests demonstrate one upstream dispatch and one set of Gmail mutations for the same owner, thread, recipe and fingerprint.
- **SC-004**: Owner isolation, disabled policy, zero credit, malformed response, timeout and unavailable-upstream tests make no Gmail mutations and expose only safe errors.
- **SC-005**: A personal-primary-model acceptance run completes Jev triage through Matrix AI without changing primary provider settings.
- **SC-006**: Normal logs contain no raw fixture body or credentials; observability still identifies recipe, request, latency, status and usage/cost outcome.
- **SC-007**: An exact-head demo shows inbox labels and at least one authorized cold-outreach archive, plus the visible Review/failure behavior.
- **SC-008**: The implementation, tests, public documentation and demo evidence pass required CI and review gates before release.
- **SC-009**: A bot created through the Jev Recipe's Build in Chat flow appears in the same user's Agent library and uses the selected Gmail account visible in that user's Services view. A save response alone is insufficient: creation MUST fail visibly if the owner-scoped readback cannot verify the bot and its account binding.
- **SC-010**: A Preview run under a non-owner user shows the same Gmail account in Services, saved Agent configuration, and a read-only `list_integration_inventory` call made by Hermes. A mismatch stops before Gmail reads or writes.

## Assumptions

- Gmail is already connected through Matrix integrations; adding a new mail provider or OAuth flow is outside this feature.
- Matrix's existing funded runtime credential and control-plane accounting remain the authority for Jev eligibility and credits.
- Cloudflare's AI REST API exposes `typesafe/jev` through `POST /ai/run`, accepts one state with several Noul questions and returns typed answers plus token usage.
- Jev settlement uses the reviewed TypeSafe input-token price with a short expiry horizon; missing usage or expired pricing follows conservative reconciliation.
- The first public demo may use a controlled test mailbox. Production mailbox mutation still requires the same authorization rules.

## Non-goals

- Personal provider keys, user-selected Jev endpoints or a Jev credential settings page.
- Research-shortlist and task-routing recipes.
- A generic `use-jevs` custom-workflow product, arbitrary user-authored recipes or a new workflow engine.
- Jev Ultrafast, browser/computer use and native Matrix OS navigation.
- Sending, replying, forwarding, trashing or deleting email.
- Advertising universal agent support or unmeasured speed/token-saving claims.

## Dependencies and release boundary

Implementation reuses the existing Gmail integration actions, Matrix skill distribution, runtime authentication and funded AI admission/settlement. Source inspection on 2026-09-22 found no Jev code on current `main`; this feature therefore adds the narrow evaluation path while preserving existing chat-model behavior.

Availability remains gated until a real owner-scoped call, credit settlement and supported-agent invocation pass. This specification authorizes implementation and review, not production deployment.
