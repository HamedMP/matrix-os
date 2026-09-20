# Validation and coordinated cutover

This is the future implementation acceptance recipe. No runtime tests or live probes were executed by the spec revision. Record exact commands, source SHA, runtime/harness/protocol versions, fixtures and outcomes in implementation-log.md. Use configured approved test credentials; do not provision paid infrastructure from this document alone.

## Fixtures

Two enrolled member computers A/B reached through the platform relay (existing customer-VPS routing; self-signed host certificates are acceptable), browser/Electron/native/CLI clients, a real Postgres test service, Clerk test org, admin, two members, an outsider with a valid Clerk session and no org relationship, and separate billing/integration managers. Fixtures set no `MATRIX_COLLABORATION_ENABLED` value and seed no rollout cohort; both must be absent from the codebase. Use one owner-selected source per project, exercising eligible API/Matrix AI delegation and owner-only subscription mode separately, Stripe sandbox and managed Matrix test rooms. Include a full project with two Chats/worktrees, a restricted folder, denied sibling/history in Git, dirty edits, app database, terminal and two integration connections (read-only and send-capable).

Resource content lives on A; B can be a recipient/integration custodian/transfer target. Test an org-managed computer assigned to a member for recovery; no organization-wide shared computer is provisioned. Test a viewer with no personal computer.

## Test commands

Run from the implementation worktree using repository Vitest configuration, for example:

```sh
pnpm exec vitest run tests/gateway/collaboration-org-precondition.test.ts tests/platform/collaboration-org-precondition.test.ts
pnpm exec vitest run tests/contracts/collaboration-direct.test.ts tests/contracts/collaboration-capabilities.test.ts tests/contracts/collaboration-execution.test.ts
pnpm exec vitest run tests/platform/organization-authority-postgres.test.ts tests/gateway/collaboration-capabilities-postgres.test.ts tests/gateway/shared-chat-worktrees-postgres.test.ts
pnpm exec vitest run tests/platform/collaboration-cutover-postgres.test.ts tests/gateway/collaboration-peer-transfer-postgres.test.ts tests/platform/org-invite-billing-postgres.test.ts
bun run build:shell:production
bun run build:desktop
```

These new test paths are assigned in tasks.md and will exist after implementation. Use the repository's actual browser/native/CLI runners for their suites; do not claim these commands validate those surfaces. Add all packet-specific tests from tasks.md, required type/build checks and relevant existing regression suites. Skip is not pass for a required DB/provider/host gate.

## Acceptance matrix

| Journey | Required evidence |
| --- | --- |
| Org-only gate | Outsider with a valid session and direct reachability is denied on every route, WebSocket, queue claim, tool and integration path; no environment flag or cohort record is consulted; missing signing/origin configuration fails closed with a generic error; a person-to-person invitation identifier outside the organization is not resolved; departure or guest expiry ends every derived grant |
| Relay transparency | Client authenticates with platform, obtains a ticket and streams Chat/files/PTY/app content to A through the relay; the relay makes no authorization decision, parses no payload and logs none (platform trace contains only permitted metadata); a forged, expired or wrong-generation ticket delivered by the relay is rejected by A; disabling platform-side policy storage does not affect an in-flight session; recipient needs no own computer |
| Peer path | B performs exact delegated integration action or stages transfer from A over authenticated direct HTTPS; wrong peer/key/operation replay denied |
| Membership | Lost/reordered webhook, direct Clerk edit and platform/control partition enforce fixed deadlines; revocation completion waits for ack/expiry; same local fence blocks REST/WS/queue/tools |
| Coarse roles | Billing manager can manage quoted spend but cannot read resource content; integration manager cannot access arbitrary personal connections; unknown Clerk roles fail closed |
| Granular profile | Contributor accesses selected folder/app/action/task only; overlapping broader allow cannot beat deny/ceiling; path moves and policy revisions preserve boundary |
| Git/shell | Restricted worker cannot recover denied files via object database/history, worktree admin paths, symlinks, proc, hooks, shell/interpreter, raw network or alternate app bridge |
| Chat disclosure | A tool result available only to one actor cannot enter a broader Chat; historical grant expansion requires reviewed audience; account/root change cannot resume hidden state; restricted artifact publish is separately approved |
| One owner source | Multiple actors share one configured eligible source; subscription owner-only mode blocks collaborator execution while discussion works; owner source change is revision-checked; exhausted source pauses without fallback |
| Group Chat | Repeated share/join creates one default shared Chat/root, named humans and explicit AI request; joining creates no worktree or account; audience ceiling protects historical content |
| Git/PR owner | New host commits use configured owner identity, PRs use owner forge identity, imported history unchanged; contributor proposals need exact owner approval; git/gh/shell/MCP bypass and changed-tree replay fail; audit retains requesting actor |
| Shared coding | Both Codex and Claude API-backed runs operate in their selected Chat worktrees with correct files/history, attributed approvals/cancellation and tool restrictions |
| Root concurrency | Two Chats run concurrently in different worktrees; same-root writers conflict/queue safely; merge/push separate from edit; restart recovers lease; dirty worktree survives Chat deletion |
| Integrations | Exact connection/tool/upstream scope; read cannot send/delete; approvals recheck policy; peer connection owner can revoke; direct-capable execution no longer traverses platform; vendor exceptions disclosed |
| Ready-to-work | Share preflight names allowed environment and missing account/dependency/approval; recipient requests exact access without hidden widening; no sensitive hidden resource-name enumeration |
| Invite costs | New/existing user sees no-compute/sponsor/provision choices; pending invite has no charge; expired quote requires renewed payer approval; duplicate accept/payment callback cannot double charge or provision |
| Ownership | Sponsoring a personal host changes payer only; org-managed member assignment retains org data/backups after departure; personal data remains personal |
| Transfer | Dirty worktree/app/Chat/file inventory staged with checksums; crashes at every phase leave one authority; credentials/memory/drafts absent; generation CAS prevents double-writable copies |
| Cutover | IDs and old action ceilings preserved; legacy proxy/WS/V1 paths, rollout flag and cohort policy removed; person-to-person records dispositioned per S20 (zero expected); old clients upgrade-required; offline/ambiguous scopes unavailable with recovery; rollback never restores legacy auth |
| Surfaces | Web Canvas then Web Desktop then Electron Desktop; applicable Web Mobile, Native Mobile and CLI share semantics/root/owner-source/Git-approval/error states; every surface uses the confirmed 525 chrome (ordinary timeline/composer, discussion drawer or sheet, access popover, Shared with me row, ordinary terminal viewport) with no new collaboration header, composer switch, share dialog or inbox |
| Scale | Record control request/metadata byte rates separately from relayed resource bytes and report relay bandwidth cost; no refresh per keystroke/chunk; verify bounded host connection/process/transfer capacity and shutdown |
| Matrix groups | Human/AI tokens cannot directly read/join private service rooms; managed group text expires during partition; no canonical AI Chat/files mirrored |

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
