# Owner-local GitHub tool for Bot and Chat

The `github_developer` tool is a bounded host broker capability, not an owner
shell or a platform GitHub OAuth service. Managed Pi and native Bot executors
never receive GitHub credentials, SSH sockets/keys or an arbitrary command tool.

## Admission and authority

| Surface | Authority | Allowed scope |
| --- | --- | --- |
| Ordinary managed Chat | Existing exact owner/run/source/root admission; full_access only | Its private or explicitly authorized project workspace |
| Matrix Bot and custom Bot | Existing direct owner Bot/task/run and recipe capability | Its fingerprint-bound private Bot workspace |
| Shared/group/background Bot | Denied | None |

No HTTP endpoint is added. The existing authenticated scope-runtime broker
binds every request to its runtime handle, generation, owner, chat and run.
Every effect goes through existing durable broker checkpoints; duplicate tool
IDs and unknown effects are never replayed automatically.

## Actions and approval

`github.developer` accepts one shared Zod discriminated action schema:

| Action | Effect | Boundary |
| --- | --- | --- |
| status | read | Bounded setup and nested repository evidence, no raw output |
| clone | write | GitHub owner/repo only; exclusive nested destination; new SSH remote |
| branch | write | New matrix/ branch from the approved SHA; no reset/force |
| commit | write | Explicit regular files, confirmed owner author/committer; expected-HEAD CAS |
| push | send | Exact approved SHA to its development branch; no force; remote readback |
| pull_request | send | Expected remote SHA, explicit base/title/body; draft only; actor/head readback |

Every action fits a 3,000-character serialized budget so its complete arguments
fit the exact approval preview. Every non-read action requires the person's
exact approval. Ordinary Chat uses the canonical approval event/submission path.
Recipe Bot uses the existing
owner Postgres approval interaction and same-task continuation. Approval binds
the canonical repository, account, branch, parent HEAD, confirmed Git author, selected-file digest,
arguments and workspace fingerprint. Server-held receipts expire, are bounded,
and are consumed once. Account/repository/root drift refuses execution.
Login and SSH setup remain explicit owner Terminal actions.

## Git execution and compatibility

Commands are fixed shell-free argv with bounded output and abort deadlines;
the only SSH command string is server-authored and quotes the owner pin path.
Host keys stay strictly pinned. The shared owner environment removes ambient
tokens/config overrides. Git operations disable system/global executable Git
configuration, hooks, fsmonitor and arbitrary file/ext transport; identity is
separately validated from the owner's global configuration. Repository includes,
filters, command overrides, URL rewrites and extra remotes are rejected.

All path components are checked without following links. Git metadata is
bounded and must contain no links or object alternates. Artifact read/write
cannot address `.git` or reserved clone staging. Cloning uses private staging,
never overwrites an existing destination, and never recursively deletes visible
owner data during recovery. Private clone and index directories live only in
owner-home `.matrix-github-staging` (0700); publication requires the destination
to share its filesystem. Allocations are capped at 64 active / 256 on disk.
A bounded, symlink-safe 15-minute sweep removes owned inactive stages older
than one hour; gateway shutdown drains the sweep and clears its timer. The
recovery scan never traverses arbitrary project trees. An interrupted publication may leave an observable
repository requiring owner recovery.

Commit staging uses literal Git pathspecs (including wildcard characters in
real filenames) and a private temporary index, preserves unrelated staged paths,
constructs a commit with the approved parent, and updates the development ref
with `update-ref` compare-and-swap. Approval binds raw working-tree bytes,
resolved repository attributes and the normalized Git blob separately. Built-in
text/EOL conversion is supported without executable filters; system/global
attribute files are excluded. Staged blobs must match approved normalization,
and raw content/attributes are rechecked before the ref moves. Safe tracking
configuration supports dotted branch names such as `release/1.0`; only the
existing `remote` and `merge` keys are accepted. In-process locks serialize this service only;
Terminal writers still use Git's index/ref locks. A post-ref reconciliation
failure or cancellation after an effect starts is an unknown effect. Unreferenced objects from a failed CAS are safe
Git-GC orphans. Existing HTTPS origins are retained and use the owner's gh helper.
Only ordinary nested clones with a real `.git` directory are supported; linked
worktrees and advanced executable Git configuration fail closed.

## Validation

Focused regressions cover shared tool/schema advertisement, actual local Git
author/committer and index preservation, stale HEAD/CAS, approved SHA push,
remote/actor/head readback, account/repository/content drift, symlinks and Git
config injection, owner environment, staging cleanup, personal/full_access
admission, canonical Chat approval and persistent exact Bot approvals.
These automatic tests do not replace real private-repository user/Bot/Chat
acceptance and matching Web/Electron media.

The existing `matrix-bot@2026-10-10.1` reference intentionally retains its
version and gains the interactive owner GitHub capability at server resolution,
so installed default Bots can use it. This does not grant background/group
execution or bypass any per-action owner approval.
