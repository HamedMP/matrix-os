# Implementation Plan: Collaboration Preview Pair

**Branch**: `codex/eng-418-preview-pair-foundation` | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)
**Tracking**: [ENG-418](https://linear.app/matrix-os/issue/ENG-418) | **Stack base**: [spec PR #3022](https://github.com/HamedMP/matrix-os/pull/3022)

## Summary

Add a maintainer-requested, immutable-candidate pair on the existing Preview
infrastructure. A trusted control plane reserves two real test owners/computers
and their common test organization atomically, uses existing encrypted durable
provisioning jobs, and publishes a non-authorizing canonical manifest only after
readiness checks. A local launcher starts two source-pinned, separately authenticated
Electron profiles. Explicit generation updates and physically verified cleanup
preserve reproductions, authorization and capacity. The feature defaults off until
approved isolated identity/origin/funding fixtures exist.

## Technical Context

**Language/Version**: TypeScript 5.9 strict on Node 24; Bash/Node for Spec Kit helpers; native workflow YAML.
**Primary Dependencies**: Existing Hono, Zod 4, Kysely, pg, jose, Electron 41, official GitHub Actions and `github/gh-stack`; no new persistence engine or credential store.
**Storage**: Platform Postgres for pair/generation/fixture leases; owner Postgres remains collaboration authority; credential-free local context/profile files use the existing Electron stores.
**Testing**: Vitest, independent real Postgres connections, existing workflow shell fixtures, actual Electron E2E/Xvfb and separately scoped live Web Desktop/Electron Desktop acceptance.
**Target Platform**: VPS-native host services plus candidate Preview platform; local targets must have an independently verified existing desktop artifact. Real advertised OS/architecture qualification is required.
**Project Type**: Existing monorepo platform/CLI/Electron tooling; no new application or parallel organization state.
**Performance Goals**: Spec SC-001–008: pair ready within 30 minutes after admission, local reopen within two minutes, 15-minute manual journey, access retirement within 15 minutes and confirmed cleanup within 30 under healthy providers.
**Constraints**: Exactly two canonical owners and machines; no customer updates, channel promotion, production actor impersonation or unbounded queue; 72-hour hard expiry and separately expiring test inference allowance.
**Scale/Scope**: One active pair per PR, at most eight configured fixture sets, maximum 32 queued requests; both owner Preview quotas remain enforced.

## Constitution Check

| Principle/gate | Design evidence | Result |
| --- | --- | --- |
| Owner data and Postgres | Pair metadata in Platform Postgres; project/grant/Chat state remains in each owner's database | Pass |
| Headless core and existing shells | Control service and launcher work without new product UI; banner consumes existing organization/connection state | Pass |
| Defense in depth | Strict contracts and route auth matrix below; trusted/candidate split, no auth bypass, bounded resources | Pass in design; activation gated |
| TDD and effectiveness | Named-fault tests precede changes; actual scripts, transactions, auth producer/consumer and processes remain real | Pass; record red/green per phase |
| Manual worktree/native stack | #3022 is preserved; new children share ENG-418 and publish through official `gh stack submit` | Pass |
| Documentation-driven delivery | Internal runbook and separate public-site PR are explicit final deliverables | Pass |
| Surface evidence | Separate Web Desktop and Electron Desktop captures; unsupported surfaces/OS targets unclaimed | Pass in design; live qualification outstanding |
| Secret/customer isolation | Approved Preview identity/service/signing/data bindings required; no privileged activation by this implementation session | Pass by fail-closed configuration; no claim spec530 is delivered |

Pre-research and post-design checks found no waived constitutional requirement.
Unavailable live prerequisites block activation/acceptance, not deterministic code
work. Do not mark the full feature or ENG-418 complete until all required live
checks and review gates actually pass.

## Project Structure

### Documentation (this feature)

```text
specs/2689-collaboration-preview-pair/
  spec.md
  plan.md
  research.md
  data-model.md
  contracts/control-api.md
  contracts/manifest-and-launcher.md
  quickstart.md
  tasks.md
  checklists/requirements.md
```

### Source Code (repository root)

```text
.specify/scripts/bash/{common,setup-plan,check-prerequisites,update-agent-context}.sh
packages/contracts/src/preview-pair.ts
packages/platform/src/preview-pair/
  types.ts config.ts migration.ts repository.ts admission.ts lifecycle.ts
  service.ts readiness.ts routes.ts wiring.ts
packages/platform/src/customer-vps-provision.ts
packages/platform/src/customer-vps-preview.ts
packages/platform/src/customer-vps-schema.ts
packages/clerk-sync/src/index.ts
scripts/preview-pair/{control,launch,artifact,profiles,processes}.mjs
.github/workflows/preview-collaboration-pair.yml
.github/workflows/desktop-build.yml
scripts/ci/execution-origin.mjs
scripts/release/build-source.mjs
desktop/src/main/preview-pair-context.ts
desktop/src/main/auth/preview-pair-binding.ts
desktop/src/renderer/src/features/preview/PreviewPairBanner.tsx
tests/scripts/speckit-feature-paths.test.ts
tests/platform/preview-pair-*.test.ts
tests/desktop/preview-pair-*.test.ts
tests/e2e/desktop/preview-pair.e2e.test.ts
docs/dev/collaboration-preview-pairs.md
```

**Structure Decision**: Extract focused modules under existing packages. Keep new
behavior out of large composition files: `main.ts`, `platform-startup.ts` and
`db.ts` receive only typed imports/composition/migration registration. Extract
rather than enlarge existing 1000+ line workflow/entrypoint behavior. Every new
module/test should stay below 500 lines.

## Architecture and Startup

1. A trusted reviewed controller resolves the open same-repository PR's full SHA,
checks maintainer eligibility and immutable execution origin, and registers exact
host/Electron artifacts. Candidate build jobs receive no provisioning authority.
2. Pair admission validates configured isolation/fixtures, locks admission and both
owners in deterministic order, leases a fixture set, and prepares both canonical
machine rows plus existing encrypted provisioning jobs in one transaction. No
provider request runs before commit; rollback leaves zero half-pair rows/jobs.
3. After commit the existing dispatcher converges both VPSes. A narrow trusted host
adapter applies the reviewed Preview platform binding with existing rollback/health
guards; normal actor login is never synthesized for infrastructure work.
4. Readiness verifies actual source/version, owner/machine/slot, empty machine access
lists, current test-org memberships, fresh control enrollment, approved platform
bindings, bounded AI availability and exact desktop artifact provenance.
5. An authenticated first-party read returns the canonical current manifest. Local
Codex/tester can supply its pair reference to the launcher; a copied file is checked
against the live authority before any connection or executable launch.
6. The launcher verifies trusted artifact/run/source/digest, creates isolated owned
profiles, and starts the same candidate app twice. Main-process pair mode disables
OTA/global protocol registration and enforces expected actor/origin/slot before
cached or new credentials can reach product calls. Each user signs in normally.
7. The existing organization stores remain authoritative. The banner displays role,
expected/actual computer/org and candidate; it never creates a second org store.
8. Actual sharing journeys run only through normal clients. Evidence keeps environment
readiness, local session readiness, product result and PR currency separate.

## Authority, Transactions and Failure Handling

- **Canonical authority**: trusted pair ledger/generation for lifecycle; verified
current identity/org projection for membership; owner Postgres for project grants,
publication, Chat execution; immutable release/run provenance for executable source.
- **Admission lock order**: pair-admission advisory lock, sorted account-deletion/
billing-owner locks, sorted provisioning-owner locks, fixture lease and active PR
row. Existing per-owner quota checks run on the same transaction connection.
- **Prepare-only VPS mode**: internal-only and requires a transaction executor. It
uses the existing provisioner but skips every inline/detached dispatch path. The
regular public Preview provision contract remains unchanged.
- **Generation fencing**: every claim/readiness/update/stop write includes expected
generation/revision and a live bounded lease. Stale callbacks cannot overwrite a
newer update or resurrect cleanup. Uniqueness is enforced in the write/index.
- **V1 update**: explicit clean reset. Retire the prior generation, invalidate its
manifest and sessions, prove both provider servers absent, then provision the next
generation. Report reset semantics before confirmation. No silent preservation claim.
- **Cleanup**: same worker for stop/expiry/PR close/request removal. Scan bounded
batches; verify exact machine labels for ambiguous creations. Logical machine
retirement is insufficient: retain capacity/fixture leases until all known and
machine-labeled servers are absent. Failure is cleanup-pending with capped backoff.
- **Shutdown**: cancel only owned in-flight work, drain owned timers/processes, leave
durable claims resumable, and destroy only pools owned by the composition root.
- **Errors**: fixed public codes/messages; detailed bounded diagnostics use run/role/
stage, never provider messages, host paths, credentials or private content.

## Security and Resource Limits

See [control API](contracts/control-api.md) and [manifest/launcher](contracts/manifest-and-launcher.md).
All mutating endpoints, including DELETE, use 16-KiB body limits and strict schemas;
all IDs/path/query values validate before service calls. External calls use 10-second
API/30-second download-request deadlines, no redirects to unvalidated destinations,
and finite whole-stage deadlines. Only configured exact first-party origins and
GitHub artifact sources are permitted; no arbitrary server-side fetch target.
Manifest/context maximum 64 KiB, two roles, eight desktop target entries, 64 diagnostic
rows/page, 32 queued requests, eight configured fixture sets, 72-hour hard pair lifetime.
Artifact archives cap at 3 GiB compressed/8 GiB expanded, 50,000 entries; verify paths,
links, declared size and digest before extraction/execution. Temporary files are
owned, symlink-safe and removed on failure; retained profiles have explicit cleanup.
Local lifecycle uses live child handles, never blind PID-file killing.

## Validation and Delivery

- First protect helper selection, strict contracts, quota/fixture races, two-job
rollback, stale claims, route auth/body limits, cleanup proof and classified-handle
boundaries with deterministic regressions using the actual producer/consumer.
- Real Postgres qualification uses independent clients for concurrent admission,
rollback and generation fencing. PGlite may support fast tests but cannot satisfy
this required qualification lane or introduce new production persistence.
- Existing ordinary provisioning, private Preview, auth, updater, protocol and
collaboration suites must retain behavior. Typecheck/patterns/production shell and
Electron production/E2E gates apply to their actual changed surfaces.
- The actual Electron E2E lane launches two preview processes and one normal process;
missing build/display/prerequisites fails explicitly. Stub service boundaries are
reported and do not establish Clerk/VPS/model acceptance.
- Protected live qualification uses two dedicated normal test logins and a separate
outsider. Execute sharing-at-creation and later-share on separate new projects,
inherited prompt persistence, restart/reconnect, revocation and failed publication.
Capture Web Desktop and Electron Desktop separately on exact candidate artifacts.
- Attach screenshots/recordings and exact-build evidence to PRs; prepare the required
review-channel handoff through the approved posting workflow. Do not commit captures.
- Update internal docs and the separate `FinnaAI/matrix-os-site` engineer-guide PR.

## Stack and Implementation Handoff

Preserve #3022 as the bottom spec PR. New native layers: planning/tooling/contracts,
Platform pair admission/lifecycle, trusted adapters/workflow/source provenance,
Electron/launcher, and qualification/docs where size requires it. Every layer shares
ENG-418; phase details and exact task/PR mapping belong in `tasks.md`. Publish only
through `gh stack submit`, request current-head Greptile review once, resolve findings,
and require 5/5 plus applicable CI before ready. Do not merge or activate customer
infrastructure. Operator isolation/fixture/funding setup and local OS access are
explicit qualification prerequisites, not silently waived tasks.

## Complexity Tracking

No constitutional exception requested. Reusing the transaction-aware provisioner,
existing job queue and account stores avoids parallel implementations. Separate
pair records are required to represent two-owner admission and physically verified
cleanup, which a single `user_machines` row cannot express.

## Runtime composition extraction

`packages/platform/src/main.ts` starts at1030 lines. This layer extracts the
complete bundle/update route family into `host-bundle-composition.ts` before
mounting the pair metadata policy, containing rather than growing the entrypoint.
Pair behavior stays in focused modules. Subsequent controller startup remains a
small composition call with its own shutdown ownership; unrelated route families
are left to later focused extraction rather than moving them with feature logic.

The2057-line sync agent's passive polling function is extracted unchanged into
the existing focused `matrix-update-manifest` library before adding paired-host
policy there. Explicit update preparation/apply remain in their current paths;
retained Bash trust tests exercise them after the extraction.

## Source startup extraction and profile fencing

The1200-line Platform startup entrypoint keeps only composition/lifetime calls.
Extract the existing customer dependency/store assembly into
`customer-vps-startup-deps.ts` before mounting the focused Preview startup module.
The private pair context chooses required provider/template ports explicitly;
it does not inherit customer billing or automatic Preview activation callbacks.
Register primary/target pool owners before subsequent startup can fail. Stop and
drain the scoped worker before closing its target and then the primary database.

Source configuration pins six immutable Secret Manager versions and test identity,
cloud resource and storage boundaries. A non-authorizing public profile digest is
required in each admitted candidate and retained in its canonical generation.
An unexpected profile cannot make a404 from a different cloud boundary release
an old lease. Restore the recorded reviewed profile to retire a generation before
changing its resource boundary. Operator credential rotation does not change it.
The current tagged-origin contract supports `matrix-platform-preview`; reject an
unsupported service family during setup rather than producing unusable origins.

Target connections do not run migrations or require liveness at construction.
Admission/activation verify actual database/role/grant isolation and prepared
schema before writes. Provider/cloud retirement can still run when the target is
offline; projection failure preserves the lease. Numeric secret references and
service-account names are not evidence of effective IAM: reviewed protected setup
and actual-target isolation remain activation prerequisites.

The protected automation layer must record a durable request intent before
publishing a revision. The existing post-candidate admission endpoint alone cannot
recover cancellation before admission; T016/T033 stay open until the trusted
orphan path proves exact resource retirement without fixture/member shortcuts.
