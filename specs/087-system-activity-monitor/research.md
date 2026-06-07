# Research: System Activity Monitor

## Decision: Implement activity collection in the customer VPS gateway

**Rationale**: The gateway already runs on the owner-controlled VPS, has authenticated owner routes, and can read local host/process/service state without exposing platform credentials or SSH. Keeping collection in the gateway makes the monitor useful from Canvas, Desktop, CLI, or mobile clients through the same contract.

**Alternatives considered**:
- Platform-only collection through fleet probes: rejected for v1 because platform snapshots are coarser, lagging, and cannot safely run local cleanup actions.
- Shell-side collection: rejected because browsers cannot access host metrics and should not hold host privileges.
- SSH-based operator collection: rejected because it does not serve end users and would require operator credentials.

## Decision: Treat System Activity Monitor as a privileged built-in app

**Rationale**: Ordinary default apps run in sandboxed `srcdoc` iframes and must use the Matrix bridge, which is not appropriate for host cleanup authority. A built-in shell app can call owner-authenticated system routes while still rendering inside the normal shell.

**Alternatives considered**:
- Default app under `home/apps/**`: rejected because it would blur sandbox boundaries and require adding privileged bridge methods to untrusted app surfaces.
- External admin page: rejected because activity monitoring should be part of the OS and work in Canvas first.

## Decision: Start with read-only snapshots and manual cleanup suggestions

**Rationale**: Read-only visibility is the safest MVP. Cleanup classification must earn trust through tests and user-visible explanations before automatic cleanup mutates resources.

**Alternatives considered**:
- Ship automatic cleanup first: rejected because stale-process classification can be wrong without real-world evidence.
- Offer arbitrary kill/delete controls: rejected because the blast radius is too high and violates defense-in-depth rules.

## Decision: Cleanup actions are typed and bound to server-generated candidates

**Rationale**: The server can classify a resource with context, issue a short-lived candidate id, and validate that the action still matches the current target before mutation. This prevents clients from sending arbitrary PIDs or paths.

**Alternatives considered**:
- Accept raw PID or path actions from the client: rejected because it enables accidental or malicious host mutation.
- Store candidates only client-side: rejected because the server must be the source of truth for safety validation.

## Decision: Use owner files for cleanup policy and history

**Rationale**: Policy and history are configuration/audit state belonging to the owner, not platform data. Files under `~/system/` match Matrix OS ownership rules and avoid new persistence dependencies.

**Alternatives considered**:
- Platform database: rejected because host cleanup policy is per-owner runtime state.
- New embedded database: rejected by the Matrix OS Kysely/Postgres-only persistence rule and unnecessary for small append-only history.

## Decision: Split memory into process RSS, cgroup anon, file cache, and kernel accounting when available

**Rationale**: Systemd cgroup memory can look inflated after bundle installs because it includes reclaimable file/kernel cache. Showing this decomposition avoids false leak conclusions and guides cleanup toward the right target.

**Alternatives considered**:
- Show one memory number: rejected because it misleads users on Linux.
- Hide cgroup memory: rejected because service-level accounting is useful when explained correctly.

## Decision: Keep automatic cleanup opt-in and conservative

**Rationale**: Automatic cleanup should only handle high-confidence stale classes such as orphaned app servers with deleted executables and no active connections, expired cleanup candidates, or bounded cache retention. Owner-visible history and a disable switch are mandatory.

**Alternatives considered**:
- Global automatic cleanup enabled by default: rejected because active-work detection has too much product risk.
- No automation ever: rejected because small VPSes benefit from self-healing once safe classes are proven.
