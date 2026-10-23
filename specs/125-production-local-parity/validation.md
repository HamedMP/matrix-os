# ENG-100: Production parity validation

[ENG-100](https://linear.app/matrix-os/issue/ENG-100/review-pr-2040-run-the-production-host-topology-locally) tracks [PR #2040](https://github.com/HamedMP/matrix-os/pull/2040).

## Scope and fixed baseline

Continue `477bf7c3d8036e7abac2a77645b0a702f20a6a26` without repeating its Option A conflict resolution. The controlled baseline is its main parent, `ff49b2131731093c1583d1984903702bf4a76b0e`, also the PR's GitHub base at the start of this validation. Later main commits must not be mistaken for PR regressions.

Validate both trees on the same Linux host, Node 24 and frozen pnpm 10.33.4 lockfile. Local parity, bind-host overrides, shell credential overrides, JWT-key fallback, and test auth bypasses must be absent from production comparisons. Preserve ordinary production Clerk verification and session revocation. Do not merge.

## Production boundary

The only intended default production behavior change is the internal sync route ordering: authenticated object uploads may use their existing 100 MiB route limit instead of the generic 10 MiB session-proxy limit. Authentication, owner object-key isolation, and route-specific limits still apply.

Two unconditional sync changes were discovered during validation: adding `.cua-driver` to hard exclusions and disabling directory-symlink following in the home watcher. Both exceed this boundary. Restore the existing main policy, retaining main's existing secret exclusions and filesystem checks. Any further sync hardening needs independent review rather than being bundled into a local development change.

Local-only additions remain explicitly configured: `MATRIX_LOCAL_PARITY_BUILD`, `MATRIX_BIND_HOST`, `AUTH_SHELL_CLERK_SECRET_KEY`, `CLERK_JWT_KEY`, and the existing E2E bypass flags. These must not be present in the disposable production bundle's build or runtime environment.

## Validation procedure

1. Compare complete main and PR test results by normalized test path and full test name, retaining assertion messages. Rerun candidate failures in both trees with identical settings before classifying them. Fix PR regressions only.
2. Run typecheck, pattern checks, and focused production-default contracts. Record failures without converting baseline failures into passes.
3. Load both production configurations using Next's real configuration loader, exercise rewrites and the Webpack hook, normalize only the checkout path, and compare sorted effective configuration snapshots. Test PostHog release-wrapper paths separately.
4. Build both canonical production shells and host bundles using identical public build inputs and runtime versions. Compare deployed scripts, systemd units, templates, dependency locks, effective configuration, and normalized output manifests. Record all remaining compiled-content differences; do not dismiss arbitrary content as timestamps.
5. Register the immutable candidate without promoting an update channel, then deploy that exact version/checksum to an explicitly disposable VPS through the supported scoped platform path. Never deploy the candidate to the owner's primary computer or fan it out to the fleet.
6. Test real Clerk sign-in, authorized and anonymous routing, Files/sync above 10 MiB, anonymous/wrong-owner Terminal WebSocket rejection, authorized Terminal input/output and reconnect, service restart, and recovery with owner identity and file hashes preserved.
7. Capture screenshots and a short recording from each affected running surface; record the exact commit, bundle version/checksum, scenario, and limitations. Attach the same accessible evidence to the PR and ticket and share it in Slack #tech, linking its permalink back to the PR.
8. Resolve CI and review findings and obtain a trusted current-head Greptile 5/5. Keep the PR draft until gates pass. Recommend engineering/integration-owner review of auth, routing, and recovery evidence.

## Runtime auth checks

| Path | Auth source | Expected negative case |
| --- | --- | --- |
| Clerk sign-in / platform routing | Clerk session and owner mapping | Anonymous private route cannot enter an owner runtime |
| Internal sync object routes | Per-machine sync credential and owner key prefix | Anonymous/wrong-owner upload denied; route limit enforced |
| Files routes | Owner gateway identity | Anonymous access denied |
| Terminal WebSocket | Registered browser query-token path and owner identity | Missing/invalid/wrong-owner token rejected |
| Scoped VPS deploy/restart | Existing platform operator authorization | Candidate deployed only to reviewed disposable machine |

## Evidence recorded so far

- Effective Next production configuration snapshots match after checkout-path normalization, including evaluated rewrites and Webpack extension aliases. SHA-256 for both: `add33ef957d21edd28c9ddeee1efc45ec44bbde9a28b9b873acc2f5f7299e877`.
- Regression tests first failed for both extra default sync-policy changes, then passed after restoring main's behavior.
- Focused production-default/auth/upload validation: 5 files, 59 tests passed. The upload test uses real Hono routing and an in-memory object-store stub; it is not live VPS evidence.
- Artifact comparison: all 88 customer-VPS files and 244 emitted kernel/observability/integration files match after checkout-path normalization. The host-bundle script, pnpm workspace settings and lockfile are byte-identical to main.

## Remaining qualification

Full-suite comparison, final production builds/output comparison, exact-bundle disposable-VPS validation, per-surface live evidence, CI, and current-head Greptile qualification must be recorded before review readiness. No screenshot from another commit or mocked auth journey qualifies.

The production build requires enough memory for main's parallel Webpack workers. Run memory-heavy gates sequentially. Local test runs require localhost sockets; restricted sandbox socket failures do not describe product behavior.

The public command documentation remains an explicit separate PR deliverable in `FinnaAI/matrix-os-site`; do not create a second website source tree here.

The supported Private Preview workflow excludes fork PRs before secret-bearing build/provisioning jobs. PR #2040 is fork-backed; no workflow or credential restriction has been bypassed. Existing Private Previews belong to other tasks and are not disposable resources for this validation. An approved operator path is needed for the exact candidate deployment.
