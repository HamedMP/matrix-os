# Native command IPC authorization

ENG-432. This extends the DevStack and native qualification contracts. Source changes, focused Linux permission experiments, uninstrumented native acceptance, paid inference and client acceptance remain separate evidence.

## Problem and outcome

The fixed root supervisor has an empty capability set and runs in the trusted `matrix` group. A Chat worker uses DynamicUser, PrivateUsers and UMask0077. The prior Chat profile published a worker-private command socket, so native supervisor dispatch received EACCES before the SDK ran. The prior Bot profile published a more permissive command socket. Both workers need one explicit, versioned command-IPC authorization policy.

The desired contract is an exclusively created root-owned per-runtime command directory with mode02733 and the verified supervisor IPC group. Setgid supplies the new socket's host group. The worker owns its newly listening socket and publishes exact mode0620 before readiness. The supervisor gains socket write through the trusted group; the worker does not join that group. The focused Linux PrivateUsers/setgid/pinned-chmod prerequisite passed separately from full native qualification. Fresh qualification of the final compiled publication and cleanup helpers is still required. A failed qualification changes the design; it never permits a capability, group-membership or world-writable fallback.

## Authorization and invariants

| Principal/path | Authorization |
| --- | --- |
| Fixed supervisor | Existing root UID, trusted matrix group, empty capabilities; connect only through a verified pinned command inode for its runtime/generation. |
| Workload | Existing DynamicUser/PrivateUsers profile and sterile environment; create its socket only in its own bind-mounted command directory, publish permissions as owner, retain existing bounded command framing. |
| Unrelated UID/GID or isolated peer workload | No socket connection or access to sibling host control paths. Equal/reused dynamic host UIDs are not proof of namespace access. |
| Operator diagnostics | Owned disposable control workers only. Never consume installed or foreign single-use command sockets. |

- Only the exclusive per-runtime command leaf changes from0733 to02733. Outer namespace roots remain0700 or the separately verified0770 IPC leaf. Runtime roots, owner state, readiness files and inference endpoints retain their existing contracts.
- Production parent trust is root ownership plus the resolved trusted matrix GID and exact02733. Test fixtures may inject an explicit owned UID/GID through typed dependencies; no environment/request bypass or global mutable trust.
- The host pins every ancestor and socket with O_PATH/nofollow, validates the final parent against that trust, then validates socket type, one link, exact0620, inherited parent GID and the expected active workload UID. Resolve the fixed source-controlled workload identity through a bounded trusted host lookup/unit binding; never derive expected UID from the untrusted socket itself or accept an arbitrary requested username. A UID range alone is insufficient identity.
- The worker pins its own socket before chmod, uses the descriptor alias and verifies unchanged inode/owner/group and final mode before publishing readiness. It must not chmod an unpinned replacement, chgrp, add capabilities or join the trusted group. Inside PrivateUsers an inherited GID may appear as overflow; host mapping proof is separate from worker-side parent/socket consistency.
- Libuv owns only an exclusive same-parent private `.w-XXXXXX/s` bind name. Its directory inherits the trusted group and exact02700. Exclusive hardlink publication creates `worker.sock`, removes the private bind name, then verifies the pinned final inode has one link and exact0620 before readiness. The empty02700 staging directory remains reserved through listener close.
- Live workers never unlink canonical socket paths or remove staging directories, including on readiness/publication failure. They close the listener, withhold readiness on failure and retain artifacts for trusted cleanup. The supervisor first fences the exact unit/root/KillMode, performs blocking stop, and requires terminal state, zero MainPID/ControlPID and empty ControlGroup (or explicit manager-proven absence). Only then may it remove known empty staging directories via parent-authorized `rmdir` and remove the owned command/runtime trees. Nonempty or unexpected staging remains an error; no traversal, chmod or DAC capability fallback is allowed. Chat retains its one-use slot; Bot/managed Pi retain bounded run/control connections. Do not touch the separate inference socket as collateral repair.
- A pin prevents pathname substitution, not a socket owner's later chmod. Confinement, namespace placement, trusted launch identity, generation and inode binding remain required.
- Keep all current network/mount/user/cgroup isolation, environment, timeout/resource, provenance, lifecycle and shutdown checks. No new public endpoint or provider/account credential is introduced.

## Policy fencing

Put one canonical command-IPC policy/version in Chat and Bot digest inputs, including modes, inherited trusted group and pin validation semantics. Bump Chat profile2→3, Bot3→4 and managed Pi3→4; managed Pi continues deriving Bot policy. Keep adapter/harness pins unchanged and preserve the owned-Node digest wrapper. Existing centralized Gateway identities consume these profiles; do not duplicate digest strings or learn trust from a capability response.

Old runtime/profile provenance must not dispatch as the new policy or have its existing directories silently chmodded. Reconciliation and cleanup remain ownership-checked. Source/build hashes separately attest executable bytes; a semantic profile digest is not byte provenance.

## Acceptance

Native qualification retains only a coarse protocol rejection code in private diagnostics: the reply must match version1, requestId and expected response type, have the strict negative envelope, and contain a primitive error string from that response type's production schema. Unknown strings/objects, additional fields or mismatched envelopes remain `supervisor_request_failed`; no raw reply is retained. This distinguishes validated rejection from an unusable reply, without proving that no unit started. Every uncertain partial create remains quarantined and all ownership, lifecycle and cleanup gates still apply. Disposable Unix framing tests exercise the production client and persisted journal code; they do not qualify actual Linux dispatch or SDK execution.

1. A focused Linux fixture proves A:0733/0700 denies the actual root/matrix caller with CapEff0; B:02733/0620 permits that caller and denies an unrelated group; C:0733/0620 still denies it. Record host/worker UID/GID, groups, user maps, pinned inode/modes and owner-side pinned chmod. No SDK/full-isolation claim from this experiment.
2. TDD covers exclusive creation/collisions, trusted parent and wrong group/UID/mode, socket replacement/pinning/closure, publication failure before readiness, Chat one-use and Bot control behavior, all three profile fences and old provenance rejection.
3. The privileged harness separately records all four host-visible UID/GID credentials, supplementary groups, all five capability vectors, NoNewPrivs, user namespace, uid/gid maps and process starttime. Stable active PID1 unit identity brackets fixed-name bounded trusted NSS lookup and observation. The supervisor must be root with the resolved matrix GID and no capabilities. Each worker must match the fixed dynamic service identity, have only its workload group, and identity-map only root and that workload UID/GID in a distinct user namespace; the trusted group remains unmapped. Ready-state metadata requires root:trusted-group02733 parent, workload:trusted-group0620 one-link socket and retained empty workload:trusted-group02700 staging. Missing or unexpected evidence fails. Rebuild exact worker outputs; use fresh namespaces and the frozen SDK/native/owned Node.
4. Require a real supervisor→fresh worker→SDK→fake broker result, peer/host denial, lifecycle/recovery/drain/cleanup and installed/peer invariance. A separate post-reconcile command-cleanup gate requires terminal/absent exact units with no control processes/cgroups and removal of every previously recorded empty staging/command/runtime tree, bracketed by unchanged live root/empty-capability supervisor evidence. Source tests and the earlier permission fixture cannot close this actual cap0 cleanup gate. Qualify Bot/control behavior separately; do not substitute a privileged operator connection for supervisor dispatch.
5. Keep paid wallet/Chat, client surfaces, full CI, production rollout and shared Linux as separate gates. Do not modify Main or installed Dev services for this repair.

## Delivery

A dependent implementation PR under ENG-432 includes repository docs and focused tests. Update the separate site repository's `content/docs/developer/devstack-local.mdx` PR with the IPC authorization/qualification boundary, without starting a site preview or invoking Clerk keyless. No merge, rollout or new cloud resource is part of this work.
