# Delivery Plan: Machine-Free Collaborative Work

**Status:** Proposed milestones, not implemented tasks or opened implementation PRs. This PR adds specifications only.

## Scope and sequence

Each milestone is a usable vertical slice with contracts, home/platform wiring, shared presentation, tests and documentation. Split implementation PRs at coherent boundaries within repository size limits; do not equate an isolated backend merge with a released milestone. Recovery/revocation tests accompany every slice. Existing sharing continues under its existing policy until new capabilities are ready.

| Milestone | Usable outcome and included stories | Required gate |
| --- | --- | --- |
| M1: Account-only participation | Story 1 plus Story 6: existing organization members without computers open shared Chat/project/terminal using the common UI | Real zero-machine/zero-subscription account; no provisioning/billing requests; platform entry and auth-return routing; Web Canvas, Web Desktop, Electron Desktop and Web Mobile evidence; Native Mobile transport/account-only-entry repair |
| M2: External invitations | Story 2 plus Story 6: email-before-signup invitations to personal resources and policy-allowed organization resources | Recipient proof, owner consent/history preview, guest grant admission, email outbox, minimal org external-sharing setting, pending/expiry/capacity races, outsider/sibling denial and revocation on all supported surfaces |
| M3: Presence and coordination | Story 3 plus Story 6: online state, typing activity without draft content, mentions and personal unread activity | Eight-person presence/reconnect tests, TTL/cap/shutdown proof, notification deduplication, permission-safe previews and keyboard/screen-reader checks |
| M4: Shared document | Story 4 plus Story 6: one document beside Chat with concurrent edits, cursors, comments, version history, undo/export | Editor spike, durable merge protocol, real-host simultaneous clients, anchor/restore tests, identity-safe local recovery and surface parity |
| M5: AI changes shared work | Story 5 plus Story 6: authorized AI proposes document edits and users review/apply them together | Guest capability confinement, existing Claude/Codex adapter qualification, payer/limit admission, requester/owner approval controls, stale proposal rejection, audit/undo, host interruption and full integrated study |

M2 does not require creating a new AI stack: existing member AI remains available under existing policy. External guest AI is unavailable until M5's constrained capability path passes; this is visible in invitation previews and composers. M2 Contributor guest grants may discuss and edit currently supported scoped resources, but no unrestricted integration execution is implied. Existing terminal sharing needs explicit controller authorization and sandbox proof before guest input is exposed.

M1 may ship as an account-only access improvement before new guest sharing or documents exist. It must not be described as completion of the entire product promise. M3-M5 are committed scope in this specification, not optional follow-ups to drop after M1.

## Surface acceptance

| Surface | Required evidence |
| --- | --- |
| Web Canvas | Open shared resources within canonical Chat/Terminal/document components and keep the same resource across presentation switches |
| Web Desktop | Same states/actions as Web Canvas; free entry does not initialize personal runtime state |
| Electron Desktop | Free-account identity and Shared with me work without a selected personal computer; links open the correct shared resource |
| Web Mobile | Fresh phone-browser signup/invitation completion; responsive discussion and document editing; reconnect/background behavior |
| Native Mobile | Repair existing direct transport first; Expo dev-client evidence for account-only discovery, invitations, shared content and new document interaction; no Expo Go claim |

All five surfaces participate where the milestone introduces an applicable capability. A missing device capture or unsupported document editor is an open gate, not a passing mock or an implicit exemption. Existing CLI permissions must remain compatible; introducing a new CLI co-editing interface is outside this release.

## Validation strategy

1. **Specification checks (this PR):** review requirements for testability, validate relative links and requirement IDs, check diff whitespace and repository patterns. No code behavior or runtime test result is claimed.
2. **Fail-first implementation:** contracts and capability derivations; account-only route/bootstrap; invitation identity/state transitions; notification audiences; editor operations; proposal decisions. Test user-observable and security outcomes rather than copying implementation.
3. **Real Postgres:** simultaneous invite/accept/revoke, pending-capacity reservation, policy disable/role downgrade, document edits/restore, idempotent proposal apply and funding reservation. Missing database configuration means unrun, not passed.
4. **Live cross-account path:** owner on a disposable enrolled VPS; an existing org member without a machine; a new external guest; an outsider. Use the real platform, relay, home and actual auth sessions. Confirm zero recipient machines, subscription/checkout activity and AI credentials before and after the entire journey.
5. **Failures and adversarial access:** forged/expired/replayed invitation proofs, wrong email/account, stale org membership, forwarded URLs, parent/sibling references, attachment/search/export leakage, cross-origin returns, prompt-injected broader tools, revoked sockets/queues, stale proposals, duplicate paid requests and unreachable policy services.
6. **Recovery:** kill browser connections, background the phone, interrupt owner gateway/runtime during a run, restart the host and disconnect the funding source. Verify saved/unsaved states, operation deduplication, expiry, owner export and no implicit payer change or second authority.
7. **Usability/performance:** ten first-time recipients; eight simultaneous participants under the network conditions in SC-003; at least 100 randomized edit/reconnect sequences; keyboard/screen-reader completion with focus restoration and non-disruptive status announcements. Capture the exact commit, bundle version, actor roles and sanitized outcomes per surface.
8. **Compatibility:** existing org-member shares, snapshots, ordinary personal Chat, private drafts, owner boot/billing, unsupported-host negotiation and Native Mobile transport. Re-run documented regressions instead of relying on old screenshots.

Production customer runtime verification uses exact VPS-native host bundles and health checks. Deployment and paid test-host provisioning are separate implementation/release actions; this spec PR performs neither. After live verification, ask whether to delete a disposable paid test VM to avoid continuing charges. Never use the user's primary computer as the default risky test host.

## Documentation deliverable

Each milestone includes a separate PR to the private `FinnaAI/matrix-os-site` repository under `content/docs/`. Cover free account entry, invitation verification, guest versus organization membership, host availability, roles and scoped AI limits, document history/export, owner-funded execution and supported surfaces. Publish only capabilities verified for that milestone. Keep documentation public-safe; no customer identities, hostnames, access tokens or incident details. The spec PR records this required deliverable; it does not publish product documentation or claim a site PR already exists.

## Review and completion

Implementation plans must reference FR-001 through FR-023 and SC-001 through SC-008, enumerate exact routes and authorization, and assign every milestone its acceptance evidence and documentation PR. Record any explicit surface limitation as a product decision before implementation, not as a late exception after a failed check.

PRs use Conventional Commit titles, source-of-truth/transaction/orphan/auth/deferred invariants, and current-head Greptile 5/5 before merge. Add `ready-for-ci` after current-head 5/5. Opening this spec PR does not authorize merging it, starting implementation, deploying or purchasing infrastructure.
