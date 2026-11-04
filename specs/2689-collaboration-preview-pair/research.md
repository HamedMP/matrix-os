# Research: collaboration preview pairs

Date: 2026-10-30. Tracking: [ENG-418](https://linear.app/matrix-os/issue/ENG-418).
Research used production code at the spec PR's base, actual Spec Kit regressions,
and independent platform, desktop and workflow investigations. No cloud resources
or user sessions were created.

## R1 — Keep the native stack and resolve Spec Kit metadata

**Decision:** Keep spec PR #3022 unchanged and put planning/tooling in its child.
Resolve `.specify/feature.json` independently of branch naming; validate explicit
directories inside `specs/`, reject malformed/escaping selections, and preserve
legacy numeric lookup including four-digit prefixes. Propagate lookup failures.

**Evidence:** The real setup/prerequisite scripts failed nine intended assertions
before the fix; all ten real Git/Bash fixtures pass after it. The child branch
now resolves the original spec through the actual planning entrypoint.

**Alternatives:** Renaming/truncating the feature number, lying through an
environment override, or changing the published spec branch would conceal the
existing incompatible producer/consumer boundary.

## R2 — Reuse transaction-aware VPS preparation

**Decision:** Add a narrow internal prepare-only operation to the existing VPS
provisioner, then reserve the pair, fixture lease, two machine rows and encrypted
provisioning jobs in one PlatformDB transaction. Dispatch only after commit.

**Evidence:** `database/transaction-scope.ts` already reuses an admitted async
transaction connection. `customer-vps-provision.ts` already prepares encrypted
jobs, verifies immutable releases, applies account-deletion admission and serializes
owner quotas. Its current dispatch must be suppressed while the pair transaction
is open. The public single-home Preview schema remains single-home.

**Alternatives:** Two sequential public provisioning calls expose half-admission;
new provider shell loops would duplicate durable provisioning/reconciliation.

## R3 — Pair inventory, fixture leases and capacity

**Decision:** Use bounded operator-configured fixture sets and durable pair,
generation and member records. Acquire one pair-admission lock, then sorted
account-admission/provisioning locks. Apply both existing owner Preview quotas;
reserve two machines atomically. Queue at most 32 requests and cap active pairs
by the configured fixture inventory (maximum eight). Do not claim ENG-325's
16-slot global queue exists in this baseline; integrate its admission contract
when delivered rather than adding an unlimited second pool.

**Evidence:** Current Preview limits are per owner/machine and there is no merged
unified controller. Pair fixture exclusivity must cover both owners and the org.
Keep reservations until physical deletion is confirmed, even after machine rows
are logically retired.

**Alternatives:** Counting only running machines, releasing identities on logical
delete, or inventing arithmetic PR numbers can leak cost or cross-test state.

## R4 — Reserve a real pair namespace

**Decision:** Derive `cp-<pr>-<run8>-<generation>-a|b` handles server-side, with a
32-character slot limit, persisted Preview class and canonical pair membership.
Reserve `cp-` in account handle admission. Extend each Preview classification,
personal-account restriction, funding and routing guard deliberately; keep shared
preview machine access lists empty. Pair authority comes from durable membership,
not the prefix.

**Evidence:** Existing public schemas and reaper recognize only `pr-N`.
`isPreviewMachine` also protects billing and personal integration boundaries.

## R5 — Isolation is an activation prerequisite

**Decision:** Pin each pair to an exact tagged Preview platform origin. Never move
shared preview traffic or activate spec530's wildcard route. Candidate authority
must use approved Preview identity/signing/data/service bindings with no customer
identity or operator-secret access. A trusted controller verifies the configured
bindings; the feature defaults disabled and reports missing isolation explicitly.

**Evidence:** `preview-platform.yml` already has `preview-isolated`, but still
binds shared staging and production Clerk secrets. Exact routing alone does not
establish identity or service-account isolation. Production provisioning authority
must remain outside the candidate process.

**Alternatives:** Production account sessions in candidate code, a shared mutable
preview host, or an unverified `isolated=true` flag are insufficient.

## R6 — Pin the desktop and its real account

**Decision:** Reuse `OPERATOR_USER_DATA_DIR`, normal device-code authentication,
existing organization state and embedded build provenance. Add a bounded pair
context before app startup. It disables OTA and protocol-registration changes,
requires the exact actor/platform/computer/slot/source and denies primary-runtime
fallback. The UI displays role and actual verified context.

**Evidence:** `desktop/src/main/index.ts` applies the profile before the single
instance lock. `auth/auth-service.ts` currently falls back to primary when restoring
a nonprimary device selection fails. Packaged startup normally checks OTA.
Independent polling authenticates each profile; deep links only focus windows.

**Alternatives:** Reusing personal profiles, injected actor headers/tokens, browser
hints without account verification, or running the installed stable app hide faults.

## R7 — Authenticate the manifest independently

**Decision:** Obtain the canonical live manifest from a fixed authenticated
first-party control-plane profile, even when given a local copy. Verify run,
generation, expiry, source and trusted origins; bind desktop artifacts to the
expected repository/workflow/run/source and independent digest. A manifest holds
no credentials and never authorizes a member.

**Alternatives:** A digest carried only by an untrusted manifest cannot authenticate
its own executable. Never forward a personal bearer to a manifest-supplied origin.

## R8 — Exact source and bounded test execution

**Decision:** Build candidate bytes separately from trusted provisioning operations.
Use explicit candidate SHA checkout and build-source validation for reusable
desktop packaging, and register host releases with `--channel none`. Bind reports
to actual installed/running versions and fresh control enrollment. Normal test
actors sign in themselves; do not reuse the existing connector's backend-created
Clerk session shortcut.

**Evidence:** The desktop reusable workflow currently inherits caller source and
`GITHUB_SHA`; explicit input plumbing is required. Preview funded access is disabled
by default, defaults to six hours and cannot exceed 24 hours. A 72-hour computer
lifetime therefore does not imply 72-hour prompt readiness. No replay refill.

## R9 — Preserve reproducibility and cleanup proof

**Decision:** Pushes mark a pair outdated. An explicit update creates a new
generation with an explicit clean reset in V1; old computers are retired and
physically removed before their capacity/fixtures can be reused. Stop, PR close,
label removal and 72-hour expiry use the same generation-fenced cleanup worker.
Provider errors stay cleanup-pending, with capped exponential backoff.

**Evidence:** Ordinary `service.delete()` reports logical deletion before all
provider deletion retries complete. Pair completion needs exact server absence,
including machine-labeled orphan servers after ambiguous creation.

## R10 — Qualification and documentation

**Decision:** Keep real Postgres transaction/uniqueness boundaries, real AuthService
producer/consumer tests, actual simultaneous Electron processes and real workflow
helpers. Then run scoped live owner/member/outsider acceptance with exact artifacts.
Report environment-ready, local-session-ready and product pass/fail separately.
Update the internal guide and make the required separate public-docs PR.

**Alternatives:** Fake gateways can qualify local session wiring but cannot qualify
Clerk, VPS routing or live model execution. No required lane silently skips.

## Primary references checked

- [Electron app API](https://www.electronjs.org/docs/latest/api/app): profile/session paths, single-instance ownership and protocol callbacks.
- [Reusable workflow context](https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations): caller context makes explicit source selection necessary.
- [GitHub workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts): digest validation supports integrity, not independent workflow/source trust.
- Repository sources: `customer-vps-provision.ts`, `customer-vps-preview.ts`, `database/transaction-scope.ts`, `preview-platform.yml`, `preview-vps.yml`, `desktop-build.yml`, `scripts/release/build-source.mjs`, `desktop/src/main/auth/auth-service.ts`.

All research questions have decisions. Live isolation, account fixtures, funding
and macOS/device access remain explicit activation/qualification prerequisites,
not unanswered architecture questions or inferred live readiness.

## Implementation refinement: immutable UI and API authorities

The current computer-selection route rejects an API hostname classified in
`MATRIX_APP_DOMAIN_HOSTS`. Existing single-PR preview aliases also move when a PR
head changes. Pair generations therefore use separate immutable Cloud Run tags
`cp-<pair8>-g<generation>-ui` and `cp-<pair8>-g<generation>-api`, bound to one
verified candidate revision. Only the UI hostname belongs in the app-host list.
Electron retains the UI gateway origin and uses the separate API authority for
normal device authentication; a runtime exchange must never fall back to primary.

Activation also pins `MATRIX_PREVIEW_PAIR_CONTROLLER_SHA`. Independent authenticated
readers verify the controller execution/workflow provenance, current open same-repo
PR, unpromoted host release, exact desktop artifact bytes and observed test-only
authority bindings. Input syntax or an enabled flag alone proves none of these.
