# Premerge host-baseline validation

Status: build integration in progress. The exact a246976 archive passed native qualification; trusted version registration, installation and the real routine lifecycle remain pending.

The selected test Computer uses Ubuntu 24.04 / glibc 2.39. The previous Preview artifact was built on glibc 2.43; its retained node-pty requires GLIBC_2.42 and fails with the bundled Node on the selected Computer. The canonical updater rolled back. Reusing those bytes is not a validation path.

## Build path

Keep the existing trusted Preview workflow, execution-origin verifier, controller pin and separate trusted publisher unchanged. That workflow deliberately checks out the exact PR head and executes its source build script with public frontend configuration. The build job does not receive the operator publication credentials. Its existing `bundle_only` action registers an immutable test version with channel `none`, without provisioning or deploying a Computer.

The source build entry proceeds directly only on the actual Linux x64 / glibc 2.39 baseline. Other hosts delegate before staging deletion or dependency installation to a minimal Ubuntu 24.04 x64 container. The isolated route accepts channel `none` only, validates the clean exact Git head against the supplied source SHA, and builds a clean tracked-source snapshot with fresh dependencies, native code, shell and terminal generation inside that userspace. No marker can waive the actual baseline check.

Reuse the digest-pinned Ubuntu base and checksum-pinned Node, pnpm and Bun recipe from the repository's existing CI image. This is a build sandbox, not a VPS runtime or a new runner/controller service. It receives only the fresh source directory, private empty HOME/cache, a separate owned disk-backed scratch directory and explicit public build inputs. Mount scratch at `/scratch`, outside the source `/work` ancestry, so the extracted artifact cannot resolve a missing dependency from the build's node_modules. It receives no checkout credentials, owner files, host dependency store, Docker socket, publisher credentials or permission configuration. Run unprivileged with resource/deadline limits and remove only its owned container and temporary files.

Return the existing named bundle, checksum, manifests, release metadata and content-addressed objects to the normal artifact path. Preserve the workflow-issued version, full source SHA/ref and channel exactly. The trusted publisher remains responsible for registering provenance. Do not publish manually or restamp old artifacts.

## Evidence gates

1. The real old production entry reaches a host-install tripwire before a Docker tripwire on an unsupported host. The fixed entry must delegate before deleting the old stage or running host pnpm. Orchestration fixtures also cover provenance, environment, output and failure cleanup; these do not qualify native bytes.
2. Build the actual pinned image and observe Linux x64 / glibc 2.39 and tool versions. Preserve the existing copied-payload ELF scan and shipped-Node loader. After packaging, smoke the actual archive's copied terminal consumer, both gateway addons, real bounded PTY exit, generation ID and `assertPinnedTerminalRuntime`, using the copied executables with the build source/store absent from resolution. Missing prerequisites are failures, not skips.
3. The unchanged trusted `bundle_only` workflow must build and register a new exact-head immutable version. CI success or a native smoke does not establish installation or account behavior.
4. Install only that new registered version on the already authorized test Computer through the canonical updater. Read back provenance, service/socket health and subscription before actual ordinary Claude Chat invokes the CLI.
5. Validate CLI read/proposal, authentic owner decisions, canonical Matrix Bot execution and revision-based pause/resume/archive/history. Keep source action, routine activation, background model and integration permissions separate. Unknown mutation/cancellation results remain explicit.

Functional PR approval is requested after its validation evidence is available. A test routine's authentic owner approval is a step within the live acceptance flow; it is not approval of the implementation. Do not automate either human decision. Record unresolved gates separately and record a product demo only after the real flow passes.

## Isolated preparation evidence (2026-11-03)

- Six focused build/packaging suites passed: 123 tests, zero skips. The initial real unsupported-host production entry reached host pnpm instead of Docker. Further named regressions cover existing Zellij preflight order, zero-byte content-addressed objects, valid setgid directories, disk scratch and build-store resolution isolation, in addition to provenance and cleanup.
- The actual minimal x64 image built in 108.93 seconds with all tool archive checksums verified. On the ARM development host it ran under QEMU and reported Linux x64, glibc 2.39 and Node 24.21.0; pnpm 10.33.4 and Bun 1.4.3 assertions passed. Actual gateway native C build, ELF compatibility and native exports loaded successfully. The supported production entry reached the intentional install tripwire. These are component checks, not a full host bundle.
- A real Docker invocation through the unsupported-host entry reached fresh container pnpm in a deliberately incomplete source fixture. It failed for the expected missing package manifest, preserved the prior host stage and removed its owned container and temporary files. This proves failure cleanup, not a successful build.
- An actual Node loader experiment in the x64 baseline image found the build-only dependency through the old nested scratch ancestry (intended failure, exit 42). The separate `/scratch` bind blocked that fallback (exit 0). Native artifact probes must still pass on the final produced bytes.
- Independent scoped source review has no remaining verified P1/P2 findings. Current JavaScript/Bash syntax and pattern checks pass; the repository pattern check retains five existing warnings and zero violations. The unchanged typed production inputs inherit the exact supplier's typecheck evidence; these script tests do not establish a new full CI result.

No full artifact, publication, test-Computer installation or real routine lifecycle is claimed by these preparation results.

## First full build and archive capacity

The unchanged trusted [execution 41620628116](https://github.com/HamedMP/matrix-os/actions/runs/41620628116) checked out exact `b8186dfb9cdce3f344d9a0075de453ce844eac67`, built in the Ubuntu baseline sandbox and passed the staged native ABI/loader gate. Its final archive check rejected a structural predicate before upload; publication was skipped. That candidate must not be installed. The failed tar was removed during owned cleanup, so its exact entry count was not observed.

Measured representative preparation already contains 292,801 dependency entries, 4,284 tracked source entries and 5,693 entries in the actual shipped Node 24.18.0 header/npm trees: 302,778 combined, before compiled outputs and the terminal generation. These measurements span the ARM development dependency tree and the real x64 Node distribution; they establish inadequate capacity in the old 300,000-entry bound, not the exact failed Linux archive inventory.

The bounded entry capacity is now 500,000. Real tar regressions accept 300,001 structurally valid entries and reject 500,001; duplicate paths and oversized individual entries have distinct safe diagnostic codes. Keep the 1 GiB individual-file, 20 GiB expanded-data and 4 GiB compressed-archive limits, all path/link/mode checks, timeouts and native probes. Successful extraction reports only entry count, expanded bytes and maximum file bytes, including when a later probe fails. Capacity tests do not close the actual artifact or live gates.

The corrected snapshot passed the same six focused suites: 127 tests, zero skips. Independent archive-capacity review and current syntax/pattern checks passed. These remain source and orchestration evidence.

## Actual native archive and trusted post-cache integration

[Execution 41624458027](https://github.com/HamedMP/matrix-os/actions/runs/41624458027), exact source `a2469764a0e6cce7a23fd2e1387531aac8e31c6b`, produced and uploaded its archive. Its actual smoke reported 310,969 entries, 4,183,701,749 expanded bytes and a maximum file of 342,636,848 bytes. The old entry cap would reject these actual bytes. Copied Node 24.18.0 / modules 137 / N-API 10 / Linux x64 / glibc 2.39 passed the actual compiled terminal consumer, both addons, real PTY marker/exit and pinned generation checks. Generation: `gen_0c02eaeff06cd55f45276ffe87dc9486508b3b40d67a0c96bc8fde71bc0a1cfc`.

The build job nevertheless failed in the unchanged setup-node post-cache action: its host pnpm store did not exist because the real install used the isolated container store. Thus publication was skipped and nothing was installed. Uploaded bytes and native Green do not substitute for a successfully registered version.

After successful artifact production and confirmed owned-container cleanup only, the helper handles this existing CI contract when `GITHUB_ACTIONS=true`: query the existing host `pnpm store path --silent`, validate a normalized absolute real path strictly within owned HOME/RUNNER_TEMP, and create missing empty directories with mode 0700. Preserve existing owned directory modes and contents, including normal group-writable 0775 paths; refuse world-writable paths, symlinks, foreign owners and unsafe/outside paths. No host install, dependency/cache copy, cache-action override, workflow change or runtime authorization follows. Failed artifacts/cleanup and non-CI calls never query the host store. The next exact-head workflow must verify the real post-cache action and trusted registration.

Final host-cache source preparation passed six focused suites, 142 tests with zero skips; the independent helper review passed 33 cases. These checks do not establish the actual post-cache or publication outcome.

## Executable build contract

### Scope / trigger

This is the build-time native artifact boundary for premerge register-only validation, not a new routine execution or authorization interface. It applies before host installation/staging and after final tar creation.

### Signatures

- `./scripts/build-host-bundle.sh`: preserve pure Zellij argument validation, then choose the actual baseline or isolated builder.
- `node scripts/host-bundle-baseline-builder.mjs --check`: exit 0 only for actual Linux x64 / glibc 2.39; no environment override.
- `node scripts/smoke-host-bundle-native.mjs <bundle.tar.gz>`: exactly one archive argument; success exits 0, failed validation exits 1, incorrect usage exits 2.

### Contracts

The isolated route requires `HOST_BUNDLE_CHANNEL=none`, a validated `HOST_BUNDLE_VERSION`, full exact `MATRIX_BUILD_SHA` and `MATRIX_BUILD_REF`. Forward only the explicitly named public frontend and release-metadata keys in the helper. `HOST_BUNDLE_DIST_DIR`, when supplied, must resolve under real checkout `dist/` directories. Source-pinned toolchain overrides and shell-build skips are rejected. Private HOME/cache and sibling scratch are owned temporary inputs; expose scratch as `/scratch`, never beneath `/work` in the container.

`GITHUB_ACTIONS` selects only the bounded host post-cache compatibility step after success; it never changes the actual native baseline check or gets forwarded as authority to the container. Host HOME/RUNNER_TEMP are containment anchors for that empty directory preparation, not input dependency stores.

The smoke emits one JSON result. Success includes `ok:true`, version 1, kind `host-bundle-native-smoke`, `buildVersion`, `gitCommit`, `archive:{entries,expandedBytes,maxFileBytes}`, actual `native` checks and `pinned` generation/runtime checks. Failure includes `ok:false`, a stable `code`, optional integer-only `archive` facts and bounded fixed-probe diagnostics. No database or owner-permission mutation is performed.

### Validation / error matrix

| Condition | Result |
| --- | --- |
| Unsupported host with invalid source/channel/output or inherited toolchain override | Fail before Docker/output mutation; no host build fallback |
| Duplicate path / more than 500,000 entries / individual file larger than 1 GiB | `artifact_archive_duplicate_entry` / `artifact_archive_entry_limit` / `artifact_archive_file_size`; allowlisted integer facts only |
| Unsafe path/link/mode, aggregate size or parser failure | `artifact_archive_rejected`; no payload execution |
| Missing required copied files | `artifact_payload_incomplete`; no native success claim |
| ABI, consumer/PTY or generation mismatch | Corresponding `artifact_native_abi_failed`, `artifact_native_consumer_failed` or generation/pinned-runtime failure; nonzero exit |
| Interrupted container client or uncertain cleanup | Attempt exact owned-container removal; unconfirmed cleanup remains failure |
| CI host store missing after successful artifact/cleanup | Read-only host store-path query and safe empty-directory preparation; invalid cache paths fail without changing existing data |

### Good / base / bad cases

- Good: exact clean premerge source builds on the pinned baseline and its copied artifact passes every native/runtime check with independently rooted scratch.
- Base: native Linux x64 / glibc 2.39 runs the original build path, preserving existing Zellij preflight diagnostics and native checks.
- Bad: newer-libc host builds directly, stale shell/native output is copied, archive rejection is suppressed, or dependency resolution falls back into the build store.

### Tests required

Keep the production-entry install/staging tripwires, strict provenance and cleanup cases, actual tar boundary/mode/link tests and original packaging/portability contracts. Required assertions distinguish metadata acceptance from native success. Actual full archive, trusted publication, installed services and live routine gates remain the separate evidence sequence above.

### Wrong vs correct

Wrong: treat a parsed manifest, successful `require` from the build checkout, or a reviewer score as artifact acceptance. Correct: run `node scripts/smoke-host-bundle-native.mjs "$DIST_DIR/matrix-host-bundle.tar.gz"` with independent `/scratch`, copied executables and a clean child environment; retain its actual inventory/runtime result, then verify installation and the real routine lifecycle separately.

## Dependencies and limits

This build adaptation starts at Draft #3105, commit `aac369d3fd3c627eabeb1c44a68279e7ac8265a9`, including the qualified Claude 2.1.317 predicate and the #3101 native ABI verifier. #3103 remains a separate Preview-runner correction; adopting its workflow through the controller is not a technical prerequisite for this source-only path.

Actual Docker availability, image transport, the unchanged 30-minute workflow budget, rebuilt payload compatibility and real test-Computer acceptance must be measured. Do not weaken origin, native, closure or authorization checks if this path fails. No merge, controller/permission change, channel promotion, customer deployment, new paid resources or Slack is included.
