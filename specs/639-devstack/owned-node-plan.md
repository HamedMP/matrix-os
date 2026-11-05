# Owned Node Runtime for Namespaced DevStack Acceptance

> Execute with subagent-driven-development; controller owns private artifacts and actual target operations.

**Goal:** Run native acceptance with a protected Node runtime without changing the installed Dev runtime or relaxing the existing root-protection gate.

**Evidence:** The real d153 qualification passed frozen SDK/native verification, then failed before any SDK execution because `/opt/matrix/runtime/node/bin/node` is root:matrix0775 and its bin directory02775. Installed services and peer state stayed identical during the attempt. Modifying these installed paths is outside authorization.

## Global Constraints

- Reuse ENG-432, no Trellis. No Main, installed Dev service/runtime, production ledger, new VPS, paid provider, merge, resource provisioning or external message changes. Preserve live local source85aa and all three OrbStack worktrees.
- Keep legacy default paths and behavior unchanged. The new host runtime override is opt-in and only valid with an explicit namespace and its canonical isolated app/home. Never silently fallback after an invalid override.
- Preserve strict root-owned, non-group/world-writable, symlink-free ancestry and executable integrity for the selected test runtime. Never accept installed group-writable Node merely because its group is matrix.
- Host executable location and sandbox execution destination are different contracts: the worker still runs `/opt/matrix/runtime/node/bin/node` inside its isolated root. Map only the reviewed protected owned runtime source read-only to that fixed destination; preserve other sandbox security, no installed Node/Codex fallback. The supervisor must execute the owned host binary.
- No secrets or real identifiers in repository docs/fixtures. Private operator preparation downloads an official pinned Node archive, verifies its published SHA256 and materializes only bin/node plus LICENSE. No pnpm/global tool installation into it. This code never downloads or creates the runtime automatically.
- TDD. No provider calls. Native GitHub stack for dependent layers, no parallel implementers. Public site docs remain a separate PR. Hard per-PR cap50files/3000additions, aim20/1000.

## Task 1: Wire one protected host runtime through native acceptance

**Own files:** focused host-config/runtime-source validation helper and tests; mechanical main/launcher/profile wiring; native control/evidence/proof/security helpers and their focused tests; repository operating documentation. Do not broaden large Gateway composition.

1. Add optional `MATRIX_SCOPE_RUNTIME_NODE_ROOT`. It is valid only for a namespace and exactly `/var/lib/matrix-devstack/<namespace>/runtime/node`, alongside canonical app/home. Absent override retains current host runtime. Expose selected host binary/root through one typed configuration/helper rather than duplicate path calculations.
2. Validate selected owned root, bin and executable and all ancestors using existing trusted-ancestry rules. Reject symlinks, missing/wrong-kind objects, unsafe permissions and non-root ownership before writes or service actions. Keep dependency/source/compiled integrity checks intact. No configuration should permit an arbitrary executable or installed runtime to masquerade as the owned root.
3. For supervisor execution use the configured host Node binary. For sandbox workers keep the existing fixed internal executable/PATH; substitute only the read-only runtime source for the fixed `/opt/matrix/runtime/node` destination. Cover fixed Chat and Bot/Pi materialization consistently or reject unsupported combinations before launch. Preserve unconfigured default unit arguments/profile compatibility. If a profile identity adjustment is necessary, explicitly document and test it; never silently weaken the attested properties.
4. Existing systemd-launcher is over1000LOC: new validation/materialization logic belongs in a focused helper. Keep its edits to mechanical configuration/pass-through calls; document this extraction boundary in report.
5. Native harness selects the canonical owned runtime explicitly; preflight, buildFacts/version/hash evidence, both supervisor starts, and worker validation must agree. Distinguish host Node execution from Node inside nsenter/root, so denial probes use the actual mapped worker executable. Receipts identify both host source hash and worker mapping. No installed executable is invoked as an optional check; retain Codex masking/negative controls.
6. Tests: invalid/unconfigured/valid override, static unsafe ancestor or executable, actual unit arguments for selected source/fixed destination, no installed fallback, legacy default arguments unchanged, receipt/mount validation mismatches rejected. Use synthetic temp files with injectable anchors only in tests, not production bypasses. Run targeted typechecks/syntax/tests and commit explicit paths. Controller separately performs new frozen native actual acceptance; mocks are not a native pass.

## Delivery and operational gate

- Independent task review, then final focused-plan review. Source guards are not bypassed for the actual run.
- Separate native stack layer above current parent/harness. Ordinary shutdown repair must be included before integrating Gateway; do not rebase a running candidate or live OrbStack projection.
- Actual target controller verifies only owned source, uses private official-archive provenance, renews exact source/lock markers and baseline, then preflight/fake-SDK/isolation/restart/drain with no provider call. Preserve all immutable failed receipts and exact-owned cleanup evidence.
