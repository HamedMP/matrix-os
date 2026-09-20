# Validation and coordinated cutover

This is the future implementation acceptance recipe. No runtime tests or live probes were executed by the spec revision. Record exact commands, source SHA, runtime/harness/protocol versions, fixtures and outcomes in implementation-log.md. Use configured approved test credentials; do not provision paid infrastructure from this document alone.

## Fixtures

Two enrolled member computers A/B reached through the platform relay (existing customer-VPS routing; self-signed host certificates are acceptable), browser/Electron/native/CLI clients, a real Postgres test service, a Clerk test organization created in the Clerk dashboard with an owner, two members and an outsider who has a valid Clerk session and no org relationship. Fixtures set no `MATRIX_COLLABORATION_ENABLED` value and seed no rollout cohort; both must be absent from the codebase. Use one owner-selected source per project, exercising eligible API/Matrix AI delegation and owner-only subscription mode separately. Stripe sandbox and managed Matrix test rooms are needed only for the deferred S14 and S16 packets. Include a full project with two Chats, one of which already owns a separate worktree with dirty edits, an app database and a terminal.

Resource content lives on A; B can be a recipient/integration custodian/transfer target. No organization-wide shared computer is provisioned. Test a viewer with no personal computer.

## Test commands

Run from the implementation worktree using repository Vitest configuration, for example:

```sh
pnpm exec vitest run tests/gateway/collaboration-org-precondition.test.ts tests/platform/collaboration-org-precondition.test.ts
pnpm exec vitest run tests/contracts/collaboration-direct.test.ts tests/contracts/collaboration-capabilities.test.ts tests/contracts/collaboration-execution.test.ts
pnpm exec vitest run tests/platform/organization-authority-postgres.test.ts tests/gateway/collaboration-capabilities-postgres.test.ts tests/gateway/project-share-inventory-postgres.test.ts
pnpm exec vitest run tests/platform/collaboration-cutover-postgres.test.ts
bun run build:shell:production
bun run build:desktop
```

These new test paths are assigned in tasks.md and will exist after implementation. Use the repository's actual browser/native/CLI runners for their suites; do not claim these commands validate those surfaces. Add all packet-specific tests from tasks.md, required type/build checks and relevant existing regression suites. Skip is not pass for a required DB/provider/host gate.

## Acceptance matrix

| Journey | Required evidence |
| --- | --- |
| Org-only gate | Outsider with a valid session and direct reachability is denied on every route, WebSocket, queue claim, tool and integration path; no environment flag or cohort record is consulted; missing signing/origin configuration fails closed with a generic error; a person-to-person invitation identifier outside the organization is not resolved; departure ends every derived grant |
| Relay transparency | Client authenticates with platform, obtains a ticket and streams Chat/files/PTY/app content to A through the relay; the relay makes no authorization decision, parses no payload and logs none (platform trace contains only permitted metadata); a forged, expired or wrong-generation ticket delivered by the relay is rejected by A; disabling platform-side policy storage does not affect an in-flight session; recipient needs no own computer |
| Peer path (deferred from V1) | B performs exact delegated integration action or stages transfer from A over authenticated direct HTTPS |
| Membership | Lost/reordered webhook, direct Clerk edit and platform/control partition enforce fixed deadlines; revocation completion waits for ack/expiry; same local fence blocks REST/WS/queue/tools |
| Coarse roles (deferred from V1) | Billing manager can manage quoted spend but cannot read resource content; integration manager cannot access arbitrary personal connections; unknown Clerk roles fail closed |
| Granular profile (deferred from V1) | Contributor accesses selected folder/app/action/task only |
| Git/shell | Sandboxed worker cannot reach host credentials, the forge token, proc/environment secrets or the credential helper; only broker operations perform Git side effects |
| Chat disclosure (deferred from V1) | A tool result available only to one actor cannot enter a broader Chat |
| One owner source | Multiple members share the owner's configured source of any kind when the organization metadata enables member submission; an organization without the metadata, or a project restricted to owner-only, blocks member execution while discussion works; readiness shows the source kind; owner source change is revision-checked; exhausted source pauses without fallback |
| Group Chat | Repeated share/join creates one default shared Chat/root, named humans and explicit AI request; joining creates no worktree or account; audience ceiling protects historical content |
| Standalone shares | Each of Chat, terminal, app instance, file and folder shared on its own grants only that resource with Viewer or Contributor; the readiness preview shows only the items that apply to the type; a terminal Viewer observes only and a Contributor may hold the controller |
| Explicit join | An organization-wide share is pending for every current member; a member who never opens it is not a participant; a member who joins the organization later sees it pending |
| Cancel and tool approval | Only the requesting member or the project owner can cancel a run or answer its tool-approval prompt; other Contributors are denied and the audit names the decider |
| Home loses a run | Restarting the gateway during a member's run marks it interrupted with the requester attributed; queued requests survive and start when the home returns, each re-admitted only on fresh membership; a queued request whose requester left the organization is dropped with notice |
| Git identity | A member's commit carries the configured owner author/committer and their push/PR uses the owner forge identity with no approval step; imported history unchanged; audit retains the requesting member and run; force push and remote changes are not offered |
| Shared coding | Both Codex and Claude API-backed runs operate on the project root with correct files/history, attributed cancellation and sandbox restrictions |
| Share inventory | Sharing a project whose Chats own separate worktrees lists every Chat with root, branch and dirty state in the confirmation; an unresolvable root blocks the share; joining creates no worktree; a dirty worktree survives Chat deletion |
| Integrations (deferred from V1) | Exact connection/tool/upstream scope; V1 evidence instead shows a member-triggered run using the owner's existing connection on the owner's host with no credential in the sandbox |
| Ready-to-work | Share preflight names the source kind, owner Git identity, inventoried Chat roots and missing owner setup; no sensitive hidden resource-name enumeration |
| Invite costs (deferred from V1) | New/existing user sees no-compute/sponsor/provision choices; pending invite has no charge; expired quote requires renewed payer approval; duplicate accept/payment callback cannot double charge or provision |
| Ownership (deferred from V1) | Sponsoring a personal host changes payer only; org-managed member assignment retains org data/backups after departure; personal data remains personal |
| Transfer (deferred from V1) | Dirty worktree/app/Chat/file inventory staged with checksums; crashes at every phase leave one authority; credentials/memory/drafts absent; generation CAS prevents double-writable copies |
| Cutover | IDs and old action ceilings preserved; legacy proxy/WS/V1 paths, rollout flag and cohort policy removed; person-to-person records dispositioned per S20 (zero expected); old clients upgrade-required; offline/ambiguous scopes unavailable with recovery; rollback never restores legacy auth |
| Surfaces | Web Canvas then Web Desktop then Electron Desktop share semantics/root/owner-source/error states using the confirmed 525 chrome; Native Mobile and CLI are a recorded V1 limitation whose existing 525 shared Chat/terminal keep working |
| Scale | Record control request/metadata byte rates separately from relayed resource bytes and report relay bandwidth cost; no refresh per keystroke/chunk; verify bounded host connection/process/transfer capacity and shutdown |
| Matrix groups (deferred from V1) | Human/AI tokens cannot directly read/join private service rooms; managed group text expires during partition; no canonical AI Chat/files mirrored |

## Operational sequence

1. Verify prerequisites, approved provider modes, configured prices and endpoint readiness. Missing source eligibility blocks that choice; required shared API modes must pass.
2. Inventory and back up owner/control data, connection custody and dirty worktrees. Record recovery key ownership and retention.
3. Fence collaboration mutation/run admission, drain sessions and stage idempotent data/grant migration. Validate counts, IDs, policy outcomes and catalog bindings.
4. Upgrade registered homes and applicable clients; snapshot current epochs, verify signing keys/TLS, require protocol acknowledgements.
5. Activate the new directory generation, the transparent relay and only the home-authorized routes. Run synthetic cross-computer journeys before reopening normal work.
6. If activation fails, keep collaboration fenced or use a compatible direct build; reconcile journals and directory generation before opening writes. Do not re-enable platform-side authorization or V1 policy.
7. After verified acceptance publish operator/user documentation through the separately authorized site PR. Paid VM cleanup follows explicit approval and preserves needed recovery evidence.

## Deferred checks

Participant AI account switching and copy-and-continue are not release gates. Future clone tests must distinguish a pinned Git commit from dirty current state and from app/Chat data; validate fresh destination grants/identity and no secret/hidden-history export. V1 tests must assert these deferred endpoints/participant source selectors are not exposed accidentally.
