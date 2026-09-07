# Research: Collaboration and Session Sharing

**Date:** 2026-09-07
**Baseline:** implementation inspected at `3c4e92c89`; specification commit `10557fef1` on PR #1558. Findings are code inspection and design decisions, not claims of successful runtime experiments. Two read-only research workstreams covered canonical Chat and platform/Terminal/project boundaries.

## 1. Reuse canonical Chat, including its existing queue

**Evidence:** `packages/gateway/src/chat/database.ts` already defines `chat_members`, `chat_user_state`, messages, runs, `chat_queued_turns`, outbox, and a partial unique one-active-run index. `queue-repository.ts` already serializes admission and claiming on the Chat row. Its pending limit is 20 and admission assumes an active run. Messages and queue entries lack human actor attribution. `routes.ts` derives personal owner from the requesting principal; `event-stream.ts` delivers owner-wide invalidations.

**Decision:** Extend existing canonical messages, queue, attempts, and outbox. Add server-derived actor/purpose and actor-scoped idempotency. Shared Chats use immutable accepted order and 32 pending slots even when initially idle. Human discussion writes a message and outbox event without admitting a Turn/Run. Retain the existing database active-run uniqueness guard.

**Rationale:** A second collaboration transcript or queue would diverge from normal Chat, restart behavior, and personal state.

**Alternatives considered:** A separate group-chat store; cloning owner state into each participant's computer; treating every human message as AI input. All conflict with canonical state or accepted scope.

## 2. Separate actor, owner, resource, and execution authority

**Evidence:** `packages/gateway/src/request-principal.ts`, `auth.ts`, and `chat/routes.ts` support owner-local request flows, including configured-owner fallback. `packages/platform/src/session-routing-proxy.ts` and `customer-vps-preview.ts` enforce machine access, with a preview-only collaborator exception. Neither machine access nor a known resource ID is item authorization.

**Decision:** Introduce a narrow `/api/collaboration` and `/ws/collaboration` ingress. Platform verifies the actual account and signs a short-lived, method/path/runtime/scope-bound actor proof; owner gateway verifies it and resolves current membership. Participants never receive an owner bearer token, generic owner-runtime route, or signed-in owner shell session. Direct owner management can use a verified owner user JWT, but collaboration routes never accept configured-owner fallback.

**Rationale:** Reusing preview-machine access would grant too much and does not drain existing connections on revoke.

**Alternatives considered:** Expanding `access_clerk_user_ids` to customer machines; rewriting participant identity to owner; client-supplied `ownerId`/URL routing. Rejected as privilege escalation.

## 3. Put authority in owner Postgres; platform holds discovery metadata

**Decision:** `collaboration_scopes` plus scope members in the authoritative owner database become the only collaboration grant authority. Existing `chat_members` becomes a derived compatibility projection for shared Chats; repositories must not fall back to it for authorization. Chat per-user state remains keyed by actor. Platform stores only opaque scope-to-runtime routing and per-user invitation/shared-item index metadata. Accepted membership is rechecked at the owner gateway for every read/mutation and stream batch.

**Rationale:** Discovery must work when an invitee owns another computer or no computer. A stale directory entry can be unavailable, but must never authorize access. Content stays in the owner's regional runtime database.

**Alternatives considered:** Central platform transcripts; separate grants in Chat/Terminal/project stores; synchronous dual writes to two databases. Use owner transaction plus outbox-driven idempotent metadata reconciliation instead.

## 4. Ship discussion before AI with explicit server gates

**Decision:** M1 enables eligible standalone Chat history and human discussion only. Shared AI submission, queue dispatch, steering, approvals, and retry are disabled for everyone, including the owner through legacy routes. An active private run must settle before conversion; the share transition fences all further personal dispatch. Sharing does not copy private provider resume state into a guest-visible object.

**Rationale:** This is the user-approved internal delivery sequence, not a reduction of the final P1 requirements. An owner legacy route must not bypass a discussion-only milestone and stream private-context output to collaborators.

**Alternatives considered:** UI-only hiding; allowing owner runs but blocking guest runs; calling a partial project a shared project. Rejected because they violate the staged boundary or all-or-nothing scope.

## 5. Shared AI requires a distinct execution context

**Evidence:** `chat/kernel-provider-adapter.ts` currently dispatches with owner identity, requires full access, and can resume an owner session. `chat/execution-root.ts` proves project/worktree provenance, not OS isolation. `agent-sandbox.ts` has provider-specific behavior and full-access overrides; it is not a universal collaboration boundary.

**Decision:** Shared dispatch receives an immutable scope/execution generation and original human actor. Existing credential and model eligibility rules continue to apply through the trusted adapter; no new funding or credential-selection product is added. Resume provenance includes scope and generation; unrestricted private SDK sessions are never resumed into shared execution. Unsupported harness/access-source combinations report unavailable.

For standalone Chat, use only the visible shared transcript and scope-local scratch/context. No parent-project files, personal memory, global tools, or personal home are available. Project file/app tools become eligible under M4's full project authority. A scoped adapter can generate outputs within its allowed context; it cannot widen access because the initiating user is the owner.

**Rationale:** A valid working directory does not protect secrets or constrain tools. SDK behavior must be proved by a bounded spike before wiring a supported shared adapter.

**Alternatives considered:** Reusing owner `full_access`; copying resume state; assuming every harness implements equivalent sandboxing. All remain prohibited.

## 6. Native execution isolation is an implementation prerequisite

**Evidence:** `distro/customer-vps/systemd-user/matrix-zellij@.service` and `packages/gateway/src/shell/user-systemd-zellij-adapter.ts` supervise the owner's environment. They improve persistence but expose the owner home. `terminal-lease.ts` supplies renderer holder/epoch controls, not actor membership. `packages/terminal-runtime` is absent at this baseline; the unmerged project-workspace stack is not an assumed dependency.

**Decision:** Introduce a versioned native scope-runtime adapter behind the existing stable session seam. Chosen isolation design: a system-owned supervisor launches a non-root scope identity with a minimal root/mount namespace, only scope-owned writable storage, no owner home/config/agent sockets/database credentials, no host process visibility/control, and a separate network namespace. No Docker customer-runtime path is introduced. Host communication is restricted to scope-specific broker endpoints with no arbitrary command/path parameters. Public network access, if required, goes through a bounded destination-validating egress broker; private/loopback/link-local destinations and redirects to them are denied.

A service unit or filesystem path is not sufficient evidence. M2's isolated adapter and M3's interactive terminal must each pass real native-host escape tests for files, environment, process inspection/signals, inherited descriptors, sockets, DNS/egress, and supervisor injection before their gates open. No unsupported isolation override exists. Existing unrestricted sessions remain unshareable; eligible sessions are launched in this boundary before sharing and retain the same process identity when invited users attach.

**Rationale:** Terminal input is arbitrary execution. Provider tool hooks alone cannot constrain an interactive shell.

**Alternatives considered:** cwd confinement; owner user-systemd instance; command allowlisting; automatically replacing an existing session; requiring the large unmerged terminal migration. Rejected. Future terminal runtime versions must satisfy the same adapter contract.

**External grounding:** systemd documents the primitives for execution identity, filesystem roots, and namespace restrictions, but does not certify this combination as Matrix isolation. The native-host test gate is our responsibility. [systemd execution reference](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).

## 7. Serialize permission changes with writes and dispatch

**Decision:** Use Kysely transactions and PostgreSQL scope-row locks before Chat/item locks, consistent lock ordering, unique constraints, revisions, and monotonically increasing authorization epochs. Never pre-read membership outside the committing operation. Queue claim and control decisions reauthorize their original actor. External provider/broker calls occur outside DB transactions through accepted commands with epoch fencing and truthful unknown-outcome recovery.

**Rationale:** Membership checks that race with revoke or two approvals cannot be corrected in the UI. PostgreSQL row locks block conflicting writers through commit; CAS predicates are still required for submitted base revisions. [PostgreSQL explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html).

**Alternatives considered:** Read-check-write without locks; in-memory grant truth; retrying an uncertain provider command as though it never ran. Rejected. The outbox is at-least-once; consumers deduplicate, and unknown external outcomes require reconciliation, not a promise of exactly-once provider effects.

## 8. Project sharing is a guarded authority transition

**Decision:** Preserve all-or-nothing inventory confirmation. Stage owned content without access; freeze project writers and new runs at a versioned cutover fence; recheck complete inventory and referenced ownership; synchronize final state; activate destination authority and membership at one declared commit point. Retain the original as a backup. Existing item-only grants never silently expand into project membership. No project capability is enabled until every present resource adapter is compatible.

**Rationale:** Files, Chats, apps, terminals, and layout currently have different ownership paths. Listing some while silently excluding the rest would violate the accepted product rule.

**Alternatives considered:** Partial project pilot; optimistic copy then dual writing; assuming a symlink is a project-owned file. Rejected. Unsupported active terminal/context migration blocks confirmation without killing or substituting the session.

## 9. Milestone gates and additive merges

**Decision:** Four separately enabled internal milestones: Chat discussion, shared AI, terminal, whole project. The six-PR delivery plan combines contracts, backend, UI and tests where reviewable to reduce CI overhead; execution proof/build and project backend/migration retain separate PRs. Every PR lands dormant or completes a tested vertical capability. Documentation updates accompany releases without becoming implementation or internal enablement gates. One platform-owned policy supplies a versioned per-milestone cohort and mode (`off`, `internal`, `enabled`, `read_only`); gateways receive bounded signed policy snapshots and recheck capabilities. There is no client-only gate. Full project availability additionally requires the full resource inventory and all prerequisite capabilities.

**Rationale:** Code can merge before use is enabled, and internal use can begin before later milestones finish. Disabling mutations must preserve owner export/revoke/recovery and existing data; an emergency access-off mode closes participant connections.

**Alternatives considered:** A single final launch switch; scattered app flags; marking security cleanup as a late milestone. Rejected.

## Research completion

Product and architectural choices are resolved for planning. SDK/sandbox compatibility and platform proof/key wiring are explicit test-first implementation gates, not asserted completed experiments. No unanswered product question or speculative timing estimate is needed to publish the plan. Rebase-level implementation research must revalidate the inspected seams before coding.
