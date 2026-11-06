# Native command IPC authorization

ENG-432. This extends the DevStack and native qualification contracts. Source changes, focused Linux permission experiments, uninstrumented native acceptance, paid inference and client acceptance remain separate evidence.

## Problem and outcome

The fixed root supervisor has an empty capability set and runs in the trusted `matrix` group. A Chat worker uses DynamicUser, PrivateUsers and UMask0077. Its current command socket is private to the worker; a native supervisor dispatch therefore receives EACCES before the SDK runs. Bot currently publishes a more permissive command socket. Both workers need one explicit, versioned command-IPC authorization policy.

The desired contract is an exclusively created root-owned per-runtime command directory with mode02733 and the verified supervisor IPC group. Setgid supplies the new socket's host group. The worker owns its newly listening socket and publishes exact mode0620 before readiness. The supervisor gains socket write through the trusted group; the worker does not join that group. Actual Linux PrivateUsers/setgid/pinned-chmod proof is a prerequisite to implementing or qualifying this candidate. A failed proof changes the design; it never permits a capability, group-membership or world-writable fallback.

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
- A failed permission publication closes the owned listener, preserves unrelated replacement objects, withholds readiness and propagates failure. Chat retains its one-use slot; Bot/managed Pi retain bounded run/control connections. Do not touch the separate inference socket as collateral repair.
- A pin prevents pathname substitution, not a socket owner's later chmod. Confinement, namespace placement, trusted launch identity, generation and inode binding remain required.
- Keep all current network/mount/user/cgroup isolation, environment, timeout/resource, provenance, lifecycle and shutdown checks. No new public endpoint or provider/account credential is introduced.

## Policy fencing

Put one canonical command-IPC policy/version in Chat and Bot digest inputs, including modes, inherited trusted group and pin validation semantics. Bump Chat profile2→3, Bot3→4 and managed Pi3→4; managed Pi continues deriving Bot policy. Keep adapter/harness pins unchanged and preserve the owned-Node digest wrapper. Existing centralized Gateway identities consume these profiles; do not duplicate digest strings or learn trust from a capability response.

Old runtime/profile provenance must not dispatch as the new policy or have its existing directories silently chmodded. Reconciliation and cleanup remain ownership-checked. Source/build hashes separately attest executable bytes; a semantic profile digest is not byte provenance.

## Acceptance

1. A focused Linux fixture proves A:0733/0700 denies the actual root/matrix caller with CapEff0; B:02733/0620 permits that caller and denies an unrelated group; C:0733/0620 still denies it. Record host/worker UID/GID, groups, user maps, pinned inode/modes and owner-side pinned chmod. No SDK/full-isolation claim from this experiment.
2. TDD covers exclusive creation/collisions, trusted parent and wrong group/UID/mode, socket replacement/pinning/closure, publication failure before readiness, Chat one-use and Bot control behavior, all three profile fences and old provenance rejection.
3. Extend actual native evidence to record user namespace/mappings and supplementary groups. Prove the worker has no trusted matrix supplementary group, and supervisor capabilities remain empty. Rebuild exact worker outputs; use fresh namespaces and the frozen SDK/native/owned Node.
4. Require a real supervisor→fresh worker→SDK→fake broker result, peer/host denial, lifecycle/recovery/drain/cleanup and installed/peer invariance. Qualify Bot/control behavior separately; do not substitute a privileged operator connection for supervisor dispatch.
5. Keep paid wallet/Chat, client surfaces, full CI, production rollout and shared Linux as separate gates. Do not modify Main or installed Dev services for this repair.

## Delivery

A dependent implementation PR under ENG-432 includes repository docs and focused tests. Update the separate site repository's `content/docs/developer/devstack-local.mdx` PR with the IPC authorization/qualification boundary, without starting a site preview or invoking Clerk keyless. No merge, rollout or new cloud resource is part of this work.
