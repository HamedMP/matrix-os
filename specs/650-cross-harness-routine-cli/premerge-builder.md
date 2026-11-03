# Premerge host-baseline validation

Status: implementation and isolated qualification in progress. No compatible new artifact or real routine lifecycle is accepted yet.

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

## Dependencies and limits

This build adaptation starts at Draft #3105, commit `aac369d3fd3c627eabeb1c44a68279e7ac8265a9`, including the qualified Claude 2.1.317 predicate and the #3101 native ABI verifier. #3103 remains a separate Preview-runner correction; adopting its workflow through the controller is not a technical prerequisite for this source-only path.

Actual Docker availability, image transport, the unchanged 30-minute workflow budget, rebuilt payload compatibility and real test-Computer acceptance must be measured. Do not weaken origin, native, closure or authorization checks if this path fails. No merge, controller/permission change, channel promotion, customer deployment, new paid resources or Slack is included.
