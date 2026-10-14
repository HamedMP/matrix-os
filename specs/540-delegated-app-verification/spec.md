# ENG-290: Delegated owner app verification

Ticket: https://linear.app/matrix-os/issue/ENG-290/let-agents-open-and-verify-owner-apps-through-delegated-app-sessions
PR: https://github.com/HamedMP/matrix-os/pull/2607

## Outcome and current implementation boundary

An explicitly approved automation run can verify an eligible owner's exact app
through production routing and the Matrix bridge without receiving owner credentials.
The registry foundation is implemented. Production issuance, routing, bridge hosting,
owner approval UI/API and lifecycle wiring are **not implemented or qualified**.
The route acceptance suite therefore remains Red. No readiness claim is permitted.

Recommend review of the authority sources and journey by runtime/security and shell
owners. Implementation authorization is recorded in the task conversation; this
recommendation does not add a permission gate.

## Authority sources

The registry accepts a typed `readAuthority(binding)` dependency. This must read
verified owner, runtime, live run, app origin, approval incarnation/deadline and
app build fingerprint from authoritative server state. It must never derive
approval or origin from caller headers, a manifest's `listingTrust`, the fixture
dependency seam, or a successful build/preflight.

The current `_apps` registry has no creation-provenance column and the inspected
Chat run records do not themselves contain app verification approvals. These are
unresolved production integration dependencies. Imported apps, unknown origins,
and missing approvals must remain denied; guessing an authority source to make
the tests green is prohibited. Real Notes eligibility needs a trusted bundled-app
receipt; a generated app needs a creation receipt bound to its owner/run/app build.

## Proposed auth matrix (routes still unimplemented)

| Operation | Authority | Boundaries |
| --- | --- | --- |
| Owner approval/revocation | Verified owner principal | Exact live run, runtime and trusted app receipt; no generic agent bearer |
| `POST /api/apps/:slug/verification-sessions` | Owner principal plus existing explicit approval | Strict runtime/run body; server resolves owner/app/TTL |
| `GET /apps/:slug/?verification=...` | One-shot capability | Platform selects only its bound runtime; gateway verifies full capability |
| Production app document/assets | Independent delegated session | Per-app HttpOnly Secure SameSite cookie; no ambient owner upgrade |
| Scoped app bridge | Delegated session and action schema | Approved slug only; no sibling app or generic gateway authority |

Endpoint names are provisional. No production dev bypass or app-session weakening
is allowed. Existing owner and mobile launch flows must retain their contracts.

## Registry guarantees

`DelegatedVerificationRegistry` limits TTL to 30 seconds and entries to 256.
Pending grants and redeemed sessions share one cap; overflow fails closed rather
than invalidating an unrelated live session. Credentials use 32 random bytes;
only SHA-256 digests are retained. Grants are not usable as session credentials.

Redemption reserves its entry synchronously before any awaited authority lookup.
Only one concurrent redemption wins. It rotates to an independent credential and
preserves the original deadline. Every authorized access rechecks approval, active
run, origin and build fingerprint. Approval replacement, expiry and build changes
invalidate existing authority. Revocation removes pending/redeemed records and
fences outstanding issuance; shutdown drains entries and cancels the cleanup timer.
Periodic TTL cleanup prevents stale growth. A process restart revokes all records.

The registry's in-process atomic boundary is not a distributed transaction. A
multi-worker deployment requires owner Postgres/Kysely coordination, not separate
registries that accept the same token. Production run cancellation must call
`revokeRun` synchronously at its authority transition as well as invalidate the
approval source. No network call belongs inside the consumption critical section.

Audit receives event type, scope and timestamp, never credential bytes. Issuance
and redemption audit failures cannot publish a credential. Timer/shutdown audit
failures are logged by error class after authority has already been removed.
Route adapters must map dependency errors to generic 5xx responses.

## Remaining production work

1. Establish trusted app creation/bundle receipts and explicit owner approval
   incarnations with Postgres/Kysely and transaction scope documented. Link related
   approval/audit writes; do not use manifest self-claims as provenance.
2. Wire the registry to canonical Chat run cancellation/completion and gateway
   shutdown, production owner/runtime identity, and the real query engine. Verify
   startup dependencies before mounting tools/routes; missing dependencies deny.
3. Validate every path/query/body with bounded strict Zod schemas. Apply Hono body
   limits before buffering for all mutations, including revocation and bridge calls.
   Bound rate limits, result sizes and pending bridge requests; apply finite timeouts.
4. Route the capability through the platform without exposing owner/Clerk credentials.
   Remove it from subsequent URLs; set no-store/referrer controls and redact proxy
   logs, telemetry and captures. Do not trust user-supplied routing headers.
5. Host the actual app under the existing dispatcher and shared Matrix bridge with
   sandbox/CSP protections. A raw HTML document or direct Vite preview does not
   qualify the host bridge. Revalidate delegated authority for every bridge request.
6. Fail closed on expired, malformed, replayed, revoked or cross-scope credentials
   with generic errors. Partial launch failure may burn a grant; it cannot restore
   replayability. Owner-authorized fresh issuance is the recovery path.

## Validation and parity

Registry unit tests cover tuple isolation, cap/cleanup, deadlines, replay,
concurrent redemption, approval/build/origin changes, revocation races, shutdown
and audit redaction. Route tests require production entry, bridge dispatch and
cookie protections, but are not yet Green. Adapter spies are not Postgres evidence.

Platform-to-gateway tests must exercise actual production auth, routing and scope
denials. Exact reviewed staging/live-app evidence must open Notes and a newly built
Vite/Postgres app in a clean automation browser, execute real MatrixOS operations,
save/reopen and observe cancellation denial. Record SHA, screenshots/recordings,
console/network status and fixture limitations. Never deploy unreviewed changes to
production for evidence.

| Surface | Approval, launch, expiry/recovery parity | Live evidence |
| --- | --- | --- |
| Web Canvas | Pending | Pending |
| Web Desktop | Pending | Pending |
| Electron Desktop | Pending | Pending |
| Web Mobile | Pending where applicable | Pending |
| Native Mobile | Pending where applicable | Pending |

Use shared state/auth derivation. N/A needs architectural rationale and reviewer
approval; another surface cannot substitute for live evidence. Share authorized
implementation evidence in Slack #tech and link the permalink in the PR.

## Public documentation and readiness

Create a companion PR in `FinnaAI/matrix-os-site` under `content/docs/` documenting
owner approval, revocation, policy denial and truthful verification. Update builder
guidance only after the supported path exists. This docs PR is not yet created.

Keep #2607 in draft until route, bridge and live evidence gates are satisfied.
`worktree-pr-monitor` requires authenticated `gh`, current-head Greptile 5/5 and
existing `ready-for-ci` label followed by passing label-triggered checks. No merge
is authorized.
