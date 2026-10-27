# ENG-306 local compatibility unblock

Issue: [ENG-306](https://linear.app/matrix-os/issue/ENG-306/upgrade-matrix-hermes-to-v0220-and-verify-native-compatibility)
PR: [2695](https://github.com/HamedMP/matrix-os/pull/2695), Draft.
Baseline: `8f755914d0a1f4f4762832bd142e1b4430f209c5`, including Codex parent
`fd52d2fd6160621dd062305a59b3420dc5475cbc` on Main `41cf5371`.
The temporary combined Preview has been deleted. Its observations below are
historical; no resource was accessed, repaired or created in this continuation.

## First-boot staging prerequisite: implemented locally

Observed on the old Preview: Sync Agent exited 1 repeatedly; staging was absent
and its root-owned parent was mode 0755. The unprivileged startup contains an
unconditional staging mkdir under `set -e`. This is a deterministic prerequisite
failure if reached, but the only observed journal command was denied. It is not
proof of the unique exit cause. These source paths are inherited from Main.

Add `/opt/matrix/staging` to cloud-init's existing `matrix:matrix 0750` directory
creation command before services start. This matches golden activation's existing
contract and does not widen parent-directory permissions. Reusing the command
also preserves the established rendered-user-data size/headroom gate.

The regression executes the shipped YAML directory commands in a disposable
filesystem, intercepting privileged ownership operations. It checks the created
private directory, intended owner/group arguments, and fail-closed sequencing
when preparation fails. It does not qualify real Linux ownership, all cloud-init
stages, Sync Agent steady state or a real provisioning transaction.

Delivery boundary: cloud-init is supplied by the platform, not retroactively
changed on a running VPS by this source edit. A candidate host bundle alone does
not apply the platform's template change. A reviewed provisioning rollout or an
explicit operator repair on a separately approved test host remains necessary.
No chmod/chown, host configuration, service, account or runtime mutation was
performed on any host. Existing-host migration is not added silently here.

## Restricted Hermes admission: security decision required

A fresh official checkout at `e06df9c2eae6901f4c88f464e0ae6e753c0428b8`
passes the unchanged production gate. Its immutable `package-lock.json` locks:
`eslint 10.12.0 -> file-entry-cache 11.1.5 -> flat-cache 6.1.23 -> flatted 3.4.4`.
All four entries are development dependencies. Official
`scripts/build/node-deps.mjs:117` explicitly requests `--include=dev` and includes
the workspace root. Changing NODE_ENV/npm omit settings is not a compatible
solution to that build contract. Removing a file after installation or moving
node_modules behind a symlink would hide the conflict and is not implemented.

The original npm tarball's lock SHA512 and Python member SHA256 are verified:
`node_modules/flatted/python/flatted.py`, 3773 bytes,
`f784c254de76a25435ebaa61c72942072733ae4b42619b943bf37b09fa45e644`.
The real Git scanner rejects that ignored official file. A separate reachability
probe keeps the production Python isolation/path prefix but substitutes its entry
body: Python can import this file through
`node_modules.flatted.python.flatted`. Thus this directory is not inherently
outside Python's import boundary. The adjacent injected Python file is rejected
as well. Probe artifacts were preserved outside the disposable source tree;
that final clean-tree pass is not a production installation fix.

**No admission code or policy changed.** A blanket exclusion of node_modules,
path-only exemption, silent deletion, or trust in arbitrary npm files is rejected.
The smallest concrete policy proposal for owner/security review is:

1. Permit only the ignored exact relative path above, bound to the current source
   pin, tracked lock entry/version and audited exact SHA256. Keep untracked and all
   other ignored import code rejected, including adjacent files and raw caches.
2. Read with bounded no-follow descriptors, verify every parent/leaf is a regular
   non-symlink identity, reject hardlinks or identity changes, and fail closed on
   missing/mismatched bytes, cancellation or timeout. Do not execute it to verify.
3. Add real Git/filesystem regressions: official bytes pass only in that one
   location; byte changes, adjacent files, wrong metadata, symlinked parents/leaf,
   hardlinks, additional pyc/pth/so/zip and aborted verification remain denied.
4. Rebuild the exact combined source, then qualify the actual installed artifact
   and restricted session on a separately approved bounded Linux host. Fresh
   current-source review and formal CI are still required.

This explicitly adds one audited artifact to the admission policy. It requires
approval beyond this round's instruction not to expand admission. It is a
proposal, not an implemented fix or a passing restricted-installed-runtime claim.
A larger build/runtime tree separation could retain zero ignored source imports,
but requires upstream layout/receipt/update integration and product-build tests;
it is not represented as a proven minimal replacement.

## Local verification and joint acceptance

Fresh isolated SDK imports use production dependency arguments and the production
PM-generation resolver. The PM facts are synthetic fixture records; the SDK
wheels are real, constrained by the official frozen uv.lock export. OpenAI
2.24.0, Anthropic 0.87.0 and MCP 2.0.0 import on Darwin arm64 Python 3.14.6 with
writes/network/subprocess/credential-read audit guards. This is not an actual PM
installation transaction, Linux qualification, model call or account acceptance.
SDK preflight returns the same selected generation checked by the resolver.

Current bounded run: **47 test files / 550 passed / 0 failed / 0 skipped**
across Hermes and the published Codex parent's affected suites. All eight native
TypeScript configurations pass. Official Gateway and Desktop builds pass. Final
staging tests independently fail against the original template and pass with the
fix; the full cloud-init suite plus those tests is 49 passed. Gateway/server and
both terminal-runtime JS production imports pass. The complete official production
import smoke still fails on this Mac at `filesystem-identity.node`: the native
builder explicitly removes that Linux-only payload on other platforms. No fake
payload or OS modification was used to turn that check green.

The evidence directory outside Git contains exact commands, red/green receipts,
source/artifact hashes, import/admission output, current targeted tests, type and
build logs. Do not conflate these with the deleted Preview's earlier evidence.
The earlier host-prerequisites workload-root suite fails four cases on this Mac
because `/usr/bin/timeout` is Linux-only; no substitute was installed into the OS.
Those failures are retained and are a Linux-runner gap, not silently skipped.
The full repository unit suite is not run in this bounded targeted continuation.

Next acceptance must identify exact candidate head and combined bundle digest,
then separately verify: first-boot staging/service health; Linux PM generation
selection and locked imports; Codex 0.162.1 managed-prefix/scope isolation; restricted
Hermes source admission; existing-account route/session continuation and harmless
already-granted MCP tools; and matching host/client visual surfaces. Provider calls,
new grants and screenshots have not been authorized or executed in this round.
Keep five surfaces distinct: Web Canvas, Web Desktop, Electron Desktop, Web Mobile,
Native Mobile. The sole GUI coordinator owns any future capture work.

Publication remains held: no push, remote CI/review, merge, production/Main update,
new resources, paid model calls, permission/credential changes or Slack messages.
Public documentation in the separate site repository remains a follow-up once
behavior and admission policy are approved; no site PR or deployment is created
under this local-only authorization.

## Subsequent local continuation

[Exact admission options and packaging spike](admission-options-2026-10-27.md)
supersede the earlier generic proposal. The four Mac workload-root failures are
now resolved in a portable component fixture without skips or system changes;
real Linux timeout/native/Host execution remains a separate queued lane. The
original failure logs are retained as historical evidence. No admission exception
or production packaging change has been implemented.
