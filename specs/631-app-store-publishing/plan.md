# Implementation Plan: App Store Publishing

**Ticket**: [ENG-322](https://linear.app/matrix-os/issue/ENG-322/add-reviewed-community-app-publishing-to-matrix-gallery), Hamed, Oct Launches  
**Stack**: `app-store-publishing` | **Spec**: [spec.md](spec.md) | **Data**: [data-model.md](data-model.md) | **Research**: [research.md](research.md) | **Contracts**: [contracts/](contracts/)

## Summary

1. Publisher VPS snapshots and scans owner source. After provider-specific consent, a confined AI agent generalizes the private draft. The same local isolated build service used by installers verifies it.
2. After final review/license/submission consent, the gateway uploads a deterministic source-only bundle. Platform verifies the exact bytes, schema, scanner and storage compatibility, then queues staff review.
3. Staff approval signs the exact source/capability/manifest identity and atomically publishes it. The platform runs no submitted code and has no build worker, jobs, dist artifacts or builder credentials.
4. Each installer VPS obtains an authenticated grant, verifies source integrity/signature and consent, and builds locally inside OS isolation. It publishes source plus locally generated output only after success. Gallery displays local build progress and errors.

## Technical Context

TypeScript strict/Node 24/ES modules; React 19/Vite apps; Hono; Zod 4. Platform persistence is Postgres/Kysely in its own `app-store` migration scope. R2 contains immutable generalized source bundles. Private owner drafts, local job records and gateway provenance use bounded files with atomic updates. Tests use existing platform Postgres fixtures, Vitest and React Testing Library; Native Mobile uses its existing mobile test runner. Keep focused modules under 500 LOC.

## Constitution Check

| Principle | Design obligation |
| --- | --- |
| Owner data | Full source with license; owner-controlled app Postgres. Separate AI-provider disclosure from Matrix submission consent. |
| AI kernel/headless | Confined SDK file agent and gateway/platform services independent of Gallery UI. |
| App ecosystem | Staff review, Ed25519 source approval and enforced capabilities. |
| Defense in depth | Auth matrix, hash/signature checks, bounded artifacts, runtime identity enforcement and real OS build isolation. |
| TDD | Failing tests first for each behavior slice; real cross-layer integration and sandbox attack tests. |
| Worktree/review | Named manual worktree; native GitHub stack; shared ENG-322; Greptile 5/5 before merge. |
| Public documentation | Separate `FinnaAI/matrix-os-site` PR under `content/docs/`, linked to ENG-322 and implementation stack. |

## Architecture

```
Publisher Gallery -> gateway draft -> provider consent -> confined AI -> isolated verification
                  -> owner review + submit consent -> source upload/finalize -> staff review
Platform          -> approval signature + publication transaction -> catalog/source-only grant
Installer Gallery -> consent -> gateway job -> verify signature/hash -> restricted registry broker
                  -> offline OS-isolated install/build -> durable source+local dist+provenance -> metrics
```

The registry broker parses lockfile records without running package code, fetches only pinned HTTPS registry packages with verified integrity, rejects non-registry dependencies and unsafe redirects, and creates a bounded immutable package cache. The build receives only the staged source, this cache and a pinned read-only toolchain. Offline install uses `--frozen-lockfile --ignore-scripts --offline`; offline Vite uses fixed argv. Submitted Vite config remains executable and must be inside the sandbox. Mount/user/PID/network namespaces, dedicated non-root identity, no capabilities or host sockets/home/secrets, hard resource limits and full process teardown are mandatory. Missing verified isolation returns unavailable. This is a per-VPS build sandbox, not the customer runtime deployment architecture.

## Source Areas

| Area | Files/responsibility |
| --- | --- |
| Contracts | `packages/contracts/src/app-store*.ts`: bounded schemas, source bundle codec/scanner, approval payload, bridge policy |
| Platform data | `packages/platform/src/app-store/{migration,types,repository-*}.ts`: listings, versions, ratings, installs, events; no build jobs |
| Platform intake | `object-store.ts`, `intake.ts`, `reviewer-allowlist.ts`, `signing.ts`, `sweeper.ts`, `internal-routes.ts`, `review-routes.ts`; startup/migration wiring |
| Shared local builds | `packages/gateway/src/app-store/{isolated-build,registry-broker,build-cache}.ts` and OS adapter: both draft verification and install/update |
| Publishing | Kernel confined agent; gateway `snapshot`, `scrub`, `generalizer`, `verify`, `publish-service`, `draft-store`, `routes-publish`, platform client |
| Installing | Gateway install jobs, provenance/grants, install/update, catalog/review proxy and runtime policy |
| Gallery | `home/apps/app-gallery/src/`: Community/detail/consent/rating, Publish/submissions, staff Review |
| Hosts | Web viewer; Electron native bridge; Native Mobile `AppRuntimeFrame`/capability broker and installed-app session |
| Docs | Local operator/developer docs and separate private site repository public docs PR |

## Delivery Stack

All branches use `codex/`; one verified ENG-322 ticket covers the native `app-store-publishing` stack. Aim for fewer than 1,000 additions/20 files; hard limit 3,000/50, splitting larger units further. Each PR links ticket, spec, stack, validation, live evidence, Slack permalink and mandatory invariants. Keep upper dependencies intact until merged. The table is a review boundary plan, not authorization to flatten layers.

| Layer | Branch suffix | Deliverable |
| --- | --- | --- |
| L0 | `app-store-spec` | This complete spec, plan, research, contracts and tasks |
| L1 | `app-store-contracts` | Source-only schemas, scanner/codec, signing payload and bridge contracts |
| L2 | `app-store-platform-data` | Migration/repositories, atomic approval and counters |
| L3 | `app-store-platform-routes` | Authenticated intake/catalog/review/grants/signing; retire insecure legacy routes |
| L4 | `app-store-local-build` | Verified OS isolation adapter, restricted broker, offline local build service |
| L5 | `app-store-publish-pipeline` | Provider-consented generalization and same isolated verifier, submit |
| L6 | `app-store-community-install` | Async local install/update, integrity/provenance/grants/runtime enforcement across hosts |
| L7 | `app-store-gallery-ui` | Community, consent/build progress, ratings, Publish and submissions |
| L8 | `app-store-review-tab` | Reviewer-only queue/source/diff/actions |
| L9 | `app-store-notifications-docs` | Notifications/tool wiring, operator docs, release/evidence integration |
| Site | Separate repository PR | Public publishing/install/rating/integration/local-build documentation |

## Execution Units and Dependencies

L1 follows spec. L2 depends on L1; L3 on L2. L4 depends only on L1 contracts and is reusable by L5/L6. L5 needs L1+L4; L6 needs L3+L4+L5 client. UI L7/L8 needs stable API contracts, and notifications L9 follows actual statuses. Parallel work is allowed only with explicit non-overlapping file ownership or deliberately prepared worktrees; tests/index mutations remain orchestrator-owned in a shared checkout.

Each layer's task group names exact files and concrete test scenarios. Tests must cover successful use, validation/authorization, concurrency, downstream failure/recovery and at least one real integration path. Recovered claims and checkbox history are not verification.

## Rollout and Qualification

1. Keep platform store flag off while signing keys, reviewer allowlist, sandbox/broker prerequisites and host bundle wiring are provisioned. `/status` remains available and reports enabled/reviewer/signing keys to authenticated gateways.
2. Deploy platform without any submitted-code execution service. Publish normal VPS-native host bundles; never replace customer deployment with Docker Compose.
3. Verify owner-provider consent, no pre-submission platform upload, exact source signature/digests, offline sandbox attack resistance, interruption cleanup, update recovery and metrics after success on a disposable supported VPS.
4. Run live Gallery scenarios on Web Desktop, Web Canvas, Electron Desktop, Web Mobile and Native Mobile separately. Native installed app runtime exists; no blanket N/A. A narrowly excluded flow requires architectural rationale and reviewer approval. Missing access/evidence blocks review readiness.
5. Attach actual screenshots plus recording links, exact commit/build and fixture/bypass limitations to PRs and Slack `#tech`; include ENG-322/stack links and backlink the Slack permalink. Recommend product/security/integration-owner review.
6. Complete the separate site docs PR; verify docs match final behavior. Publish two seed apps with different installer identities before launch. Enable store only after all gates pass.

## Complexity and Safety

The OS sandbox is mandatory because executable source is built on an owner VPS. A temporary directory or scrubbed spawn environment cannot replace it. The registry broker separates dependency network access from submitted code. Ed25519 binds reviewed source to download grants; public keys come from the authenticated platform, never from bundles. Local output hashes are provenance, not a promise of byte-identical builds on all VPSes.
