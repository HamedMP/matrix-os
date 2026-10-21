# Resource identity and owner reauthorization — ENG-326

Goal: an existing grant must never bind to a replacement file or folder merely
because its path and coarse filesystem timestamps match. Hamed explicitly chose
one-time owner reauthorization for existing file/folder shares on 19 October 2026.
General creation of standalone scopes stays disabled. App registry identity,
grant roles, namespace isolation and existing checks remain authoritative.

## Identity and deployment

Use one descriptor-bound, domain-versioned physical identity for inspection,
fingerprinting and content admission. Its digest includes filesystem identity
and the kernel's opaque object handle, preserving ordinary edits, chmod,
renames, folder child changes and process restarts on supported local Linux
filesystems. Package the native provider with the gateway. Missing binaries,
unsupported filesystems or invalid provider output fail unavailable; timestamps,
contents and copied user xattrs are never identity fallbacks. Qualify only the
following Linux filesystem policies; ordinary inode ownership is not trusted
generation authority, including files created by delegated workloads.

* ext4: Linux 6.1+ with the reviewed ext4 ioctl ordering, full filesystem UUID,
  and proven metadata checksum protection. The opened target must belong to the
  gateway's effective UID and the calling process must have no seccomp filter.
  Successful `EXT4_IOC_GETFSUUID` precedes the protection probe. The
  `EXT4_IOC_SETVERSION` probe supplies `UINTPTR_MAX`, an invalid userspace
  pointer: only the metadata-checksum `ENOTTY` result is accepted. Mutable
  generation filesystems return `EFAULT` before any inode lock, journal or
  metadata write; `EPERM`, `EROFS`, unexpected success and other errors reject.
  Seccomp is checked first so a synthesized errno cannot attest protection.
* tmpfs: opaque generation handle plus mount-lifetime filesystem identity,
  independently of the ext4 gate. Objects and their identities do not survive
  destruction of the filesystem itself.

This deliberately makes filtered ext4 gateways and foreign-owned ext4 targets
unavailable. The protected CI container uses tmpfs and remains supported; its
seccomp policy is not weakened. The host gateway service currently declares
`User=matrix` without a syscall filter; validate actual deployment capabilities
before rollout. ext2/3, overlay, XFS and other configurations are not qualified.
Host administrators can replace filesystems/clones and remain outside this
boundary. Read-only kernel references:
[ext4 ioctl ordering and UUID API](https://github.com/torvalds/linux/blob/v6.8/fs/ext4/ioctl.c#L1091-L1203),
[invalid userspace access behavior](https://www.kernel.org/doc/html/latest/core-api/mm-api.html#user-space-memory-access).
Disposable Fast CI validation on 6.8.0-139 returned the protected result with
content, inode, mode, owner, size and atime/mtime/ctime unchanged. No valid
generation value is ever supplied to the probe. Native encoding and digest use
version 2 before initial release; legacy metadata digests remain invalid.

Legacy digests are not silently migrated. Compare the current physical object
before reads and mutations, including staged upload commit and standalone folder
roots. A legitimate atomic write updates its existing catalog identity only
after admission under the existing scope/namespace/catalog transaction locks.
Replayed completed operations return their recorded result without repeating a
filesystem side effect. A missing or replaced object fails not_found.

Existing catalog IDs never acquire an unrelated post-operation path identity.
Writes and streamed uploads return the identity captured from their created
temporary descriptor before publication. Rename preserves the admitted identity
and verifies the destination rather than blessing a newly found object. A
concurrent external filesystem writer or a failed database commit can leave bytes
ahead of rolled-back catalog state; access then fails closed and requires owner
recovery. Database locks serialize gateway operations, not independent filesystem
writers, and do not promise rollback of filesystem side effects.

## Owner recovery and auth matrix

| Route | Authority | Behavior |
| --- | --- | --- |
| Existing owner-runtime catalog reauthorization inspect POST | Existing owner-only runtime proof, exact scope/resource/organization | Read-only preview of current identity and expected revision; no catalog rotation |
| Existing owner-runtime catalog reauthorization confirm POST | Same owner proof plus explicit current identity confirmation and revision | Fresh physical check, locked CAS update of existing identity; no new scope or role |
| Existing collaborator file/list/mutation/upload routes | Existing actor proof and grant capability | Require current standalone root and applicable target/parent identities |

Keep request body limits, exact path allowlists and strict schemas. Wrong owner,
runtime, scope, kind or namespace cannot reauthorize; stale revisions and changed
objects conflict. Do not disclose raw handles, filesystem identifiers, credentials
or backend errors. Owner confirmation retains the existing share ID only after
explicit approval of the current object. Folder confirmation invalidates descendant
physical identities in place with revision bumps; each requires fresh owner
confirmation before use, without reviving permanently tombstoned resources.


For the approved one-time owner recovery, an existing personal standalone file or
folder scope also binds inspection/confirmation of its cataloged **folder
ancestors**, strictly by path-segment ancestry within the same owner/project
namespace. This is an owner-only recovery binding, not an access grant: siblings,
unrelated entries, other namespaces and new scopes remain excluded. Recover
catalog ancestors from the top down using explicit current identity/revision
confirmation; no ancestor needs an independently shared scope. Confirming any
folder still invalidates all file/folder descendants in place, including other
share roots, so it never implicitly reauthorizes a child or sibling grant. Each
required descendant then needs its own explicit confirmation. Existing owner,
organization, runtime, authority-generation and membership checks remain in force.
Ancestor lookup is bounded by the existing 4096-character resource-path contract
(at most 2048 segments), using one namespace/path query rather than a database
round trip per segment. Both operations revalidate the live scope/catalog path
binding after namespace-lock admission, so a path moved while waiting cannot
retain stale ancestor or subtree authority.

## Failure, resources and validation

The native operation is metadata-only, bounded and unprivileged; it never opens an
object by a privileged handle or retains file descriptors to hide inode reuse.
Native build output is generated, excluded from source provenance, shipped in the
runtime bundle and checked by build/loader tests. Restore or unsupported deployment
must fail closed instead of promising identity continuity it cannot prove.

Retain the original recreation, metadata, folder, namespace, app, streaming and
upload tests. Add colliding-stat and alternate-path coverage, unchanged-generation
controls, two-process continuity, unavailable provider cases, mutation/upload
rebinding rejection, standalone root fencing, and owner-only CAS reauthorization
with stable links and descendant invalidation. Use disposable data only. Full
relevant checks, independent bypass/regression review, Greptile 5/5 and genuine CI
are required before merge. Public engineer documentation follows working behavior.
