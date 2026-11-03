# ENG-306: exact flatted admission decision and packaging alternatives

Status: proposal only. No exception is implemented. Local source at e825526
retains the published 8f755914 admission code and Codex parent fd52d2fd.

## Artifact identity and verification

- Upstream Hermes: v0.22.0, exact commit
  `e06df9c2eae6901f4c88f464e0ae6e753c0428b8`.
- npm package: `flatted@3.4.4`, locked development dependency through
  eslint10.12.0 → file-entry-cache11.1.5 → flat-cache6.1.23.
- Only candidate relative path:
  `node_modules/flatted/python/flatted.py` under the verified canonical source
  root. Default canonical absolute path:
  `/home/matrix/home/.hermes/hermes-agent/node_modules/flatted/python/flatted.py`.
  Do not expand an arbitrary suffix, profile directory, sibling tree or symlink.
- Size: **3773 bytes**. SHA256:
  `f784c254de76a25435ebaa61c72942072733ae4b42619b943bf37b09fa45e644`.
- [Official immutable npm lock](https://github.com/NousResearch/hermes-agent/blob/e06df9c2eae6901f4c88f464e0ae6e753c0428b8/package-lock.json)
  names [the npm tarball](https://registry.npmjs.org/flatted/-/flatted-3.4.4.tgz),
  with SHA512 integrity:
  `sha512-5+ybhBZANEJxaH3X5evAFatUxLfEHSr7n6kYJ+1Qd0mUqr4eu9gIf6GDbWHf8RJijHrjjO8G+la14SlL2SeS1Q==`.
- Both the tarball SHA512 and extracted member SHA256 were checked locally.
  The earlier installed Preview member hash independently matched. That resource
  is deleted; no fresh access was used. Original archive and member are retained.
- An AST inspection of this exact member finds only the stdlib json import,
  class definitions and function definitions at module top level. An isolated
  import produced no guarded network/write/subprocess/credential access. This is
  evidence about these bytes, not authority to trust other npm Python payloads.

## Why the existing gate rejects it

The gate first requires the exact Git pin and clean tracked source. It then
rejects ignored/untracked Python-import payloads outside its existing installed
venv and canonical bytecode-cache exclusions. This file is ignored by Git under
node_modules, so tracked cleanliness does not qualify it. Real Git scanning
reproduces the failure. Python isolation still appends the verified source root;
a separate probe proves namespace import can reach this file. Ignoring all of
node_modules therefore expands executable Python admission.

## Exact exception proposal (approval required, not implemented)

Proposed behavior: when the ignored-file scan returns that one exact relative
path, validate the artifact identity below before treating only that file as
non-violating. An otherwise empty scan keeps its current behavior. The exception
must not make the file mandatory on clean installs, proactively import it, add a
tool, add a provider, grant filesystem/network access or expose credentials.
However, it does add these bytes to the accepted Python code set and is a real
policy change, even though the file normally belongs to Node tooling.

Required checks and restrictions:

1. Keep exact source-pin/tracked-diff checks first. Bind to the one immutable
   tracked lock entry, package name/version, tarball integrity, exact relative
   path, 3773-byte size and SHA256. Do not silently accept later versions.
2. Open and pin each canonical parent as a directory without following links;
   open the leaf as a bounded regular file with no-follow/nonblocking flags,
   nlink1 and stable identity. Reject symlinked ancestors/leaf, hardlinks, replaced
   identities, changed metadata/content, read errors, cancellation and deadlines.
   A realpath/lstat check followed by a fresh path open is not sufficient proof.
3. Validate the bounded package metadata and tracked lock as data; never execute
   package hooks, Python or npm to establish trust. Never exempt an untracked
   file merely because its suffix matches the candidate path.
4. Reject every other ignored/untracked py/pyc/pyo/pth/so/zip addition exactly as
   before. Keep existing interpreter/generation binding, private cache prefix,
   no-site/no-startup-hook isolation, recipe credential and tool boundaries.
5. Bind the checked bytes to the artifact used for launch. A writable-source
   update between verification and use is a residual race: implementation must
   demonstrate a suitable immutable artifact/snapshot or effective update-lock
   lifetime. Do not claim a one-time digest alone eliminates it. If that cannot
   be demonstrated without broader changes, keep rejection and return the
   expanded design for review rather than silently enlarging this proposal.
6. Required regressions: official member in only the exact ignored location;
   changed bytes/size/version/lock, adjacent imports, wrong path, untracked
   spoofing, links, replacement races, raw caches and abort/timeout failures.
   Qualification also needs actual installed Linux source and restricted session.

Approval scope should be just implementing/testing this precise artifact rule
and its stated safeguards. It would not approve publication, deployment, Main
updates, other files/versions, model calls, account grants or a fleet rollout.
The current authorization expressly withholds the exception; no such code exists.

Rollback: revert the future single exception commit and rebuild its candidate.
The current fail-closed behavior returns immediately for installs containing the
ignored member. Withdraw that candidate from further qualification; do not alter
owner credentials/configuration, reset PM facts, delete live files, or roll out to
Main automatically. Source/version promotion remains a separate reviewed action.

## Alternatives retaining the zero-added-Python admission rule

| Alternative | Evidence / feasibility | Delivery and remaining work |
| --- | --- | --- |
| Separate reproducible runtime artifact, omit the non-runtime Python member while retaining the full build input | A local two-artifact spike retains the official tarball and full package. A separately curated copy omits only the 3773-byte Python member; every other member is byte-identical. The original real Git gate rejects the full copy and accepts the curated copy. Real CJS and ESM cycle/shared-reference round trips pass for both copies (4 cases). The package's JS exports target cjs/esm, not Python. | This preserves current admission and is the preferred next investigation before a policy exception. It is not an official unmodified npm package and must carry an explicit curation manifest. Need full Hermes TUI/web builds, runtime dependencies, PM receipts, canonical install keys/generations and update/recovery qualification. No installer patch or live deletion is implemented. |
| Production-only Node install | The exact upstream build command explicitly includes dev and the workspace root. An environment-only omit setting cannot override that contract reliably. | Needs an upstream-supported build/runtime split or a newly reviewed source pin. Not a drop-in flag change at the current immutable pin. |
| Remove the file after every local install/build | It can make the scan empty without changing the gate, but modifies installed dependency contents. A later PM build/update can restore it; PM's completion receipt is not evidence that curated bytes remain installed. | Do not silently delete the installed member as a workaround. Consider only an explicit reproducible artifact stage with manifests and complete update/recovery coverage, as above. |
| Change the locked dependency version | No alternate version without a Python payload has been qualified. Changing the tracked upstream lock breaks current pin/cleanliness qualification. | Requires dependency/security review and a new upstream source/lock qualification; do not assume an older package is safer. |
| Move or symlink node_modules outside the scanned tree | The Python namespace/file payload remains reachable while lexical scanning may stop seeing it. | Rejected: hides reachable code and defeats the existing boundary. |

The curated-artifact spike is intentionally narrow. It proves the single npm
member is unnecessary for the exercised JS exports and that the unchanged gate
can accept that separate artifact. It does not prove all Hermes features, an
actual PM transaction, update freshness, Linux deployment or live account use.
Original/full artifacts and all probe outputs are preserved outside Git.

## Portable workload-root regression and queued Linux validation

The unit fixture now stubs only the unrelated Sites migration command, checking
its original argv and propagating status37. It retains the actual workload-root
Python and real temporary filesystem operations, including link rejection and
owner-data/mode/identity preservation. The test process keeps its 10s deadline.
No /usr/bin binary or host security setting was changed. The existing 9 cases
plus a new failure-propagation case execute without skips on Mac. Temporarily
removing the real production preparation call causes7 failures; restoring it
passes. Together with staging/cloud-init this is59 passed/0 skipped.

A bounded Linux preparation probe used only existing toolchain images, no network,
no capabilities and no user configuration mounts. Its first run failed because
noexec tmpfs prevented fixture executables and native module mapping; the read-only
root filesystem also prevented the accidental package-install fallback. Those
failures are retained and are not production defect evidence. Security flags were
not relaxed. The corrected test image places executable fixture tools and the
actual native module in its image layers, retaining read-only/unprivileged runtime
and noexec scratch. The shipped native builder compiled successfully in that
small image before the coordinator's heavy-build window handoff.

Further Linux native/Host execution is queued behind ENG-318. No second engine
start or configuration change occurred. The prepared image uses Linux arm64;
the restored coordinator receipt also provides an existing Linux x64/Node24.18.0
image for the actual customer-host architecture. Do not present arm64 compile,
container fixtures or Python3.12 toolchain presence as x64 Host, Python3.14 Hermes,
full production loader, systemd or PM installation qualification.
