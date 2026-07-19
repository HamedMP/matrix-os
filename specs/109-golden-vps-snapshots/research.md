# Research: Golden VPS Snapshots

## Official sources consulted

- [Hetzner Cloud API reference](https://docs.hetzner.cloud/reference/cloud)
- [Hetzner snapshot and backup overview](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/)
- [Hetzner snapshot FAQ](https://docs.hetzner.com/cloud/servers/backups-snapshots/faq/)
- [Hetzner server FAQ](https://docs.hetzner.com/cloud/servers/faq/)
- [Hetzner Cloud API changelog](https://docs.hetzner.cloud/changelog)
- [Official `hcloud-go` image client](https://github.com/hetznercloud/hcloud-go/blob/main/hcloud/image.go)
- [Official `hcloud-go` server client](https://github.com/hetznercloud/hcloud-go/blob/main/hcloud/server.go)
- [Official `hcloud-go` Action client](https://github.com/hetznercloud/hcloud-go/blob/main/hcloud/action.go)

The source spike inspected the current official client as executable API-schema evidence. It did not create, mutate, or delete provider resources.

## Decision 1: Treat provider mutations as asynchronous operations

**Decision**: Persist both the returned resource ID and Action ID for server and snapshot creation. Poll the Action with bounded backoff until `success` or `error`, then independently verify the resource (`image.status = available`, expected labels/provenance, architecture, disk size) before advancing lifecycle state.

**Rationale**: Hetzner Actions are asynchronous. The official server client returns both server and Action for create, and both image and Action for create-image. Official server documentation also warns that a server can be assigned an ID and later be deleted when the allocation Action fails.

**Alternatives considered**:

- Treat HTTP 2xx as completion: rejected because it can expose an allocating or failed resource.
- Poll only the image/server resource: rejected because Action failure carries the authoritative operation result and a resource can disappear.

## Decision 2: Never classify timeouts as definite failure

**Decision**: Any request timeout after a create/delete may be ambiguous. Persist the pending operation before the provider call, reconcile known IDs and exact immutable labels, and only retry creation after proving no adoptable resource exists. Delete completes only after exact-ID GET returns not found (or a documented terminal delete result), never merely because the DELETE response was lost.

**Rationale**: The API documents 504/timeouts as retryable, but does not guarantee whether the mutation was applied. Arbitrary project-wide Action listing was removed; reconciliation therefore must retain Action IDs and resource labels.

**Alternatives considered**:

- Immediate retry: rejected because it can create duplicate billable builders, images, or customer servers.
- Search by human description/name: rejected because names/descriptions are not immutable provenance.

## Decision 3: Shut down and quiesce before capture

**Decision**: The builder explicitly stops Matrix/customer services, syncs filesystems, completes sanitation, disables services that can recreate state, and powers off before `create_image`.

**Rationale**: Hetzner describes snapshots as copies of the server disk; the official API guidance recommends shutting down a running server to ensure disk consistency. The approved spec requires a quiesced capture.

**Alternatives considered**:

- Live snapshot after `sync`: rejected because application/database writes may remain inconsistent or restart state creation.
- Provider backup: rejected because backups are server-bound and deleted with the source server; V1 needs an independent snapshot.

## Decision 4: Model architecture, location policy, and disk separately

**Decision**: A compatibility class records architecture, provider/region policy, base-image generation, boot mode, activation ABI, and minimum disk. Selection validates all fields against the requested server type/location.

**Rationale**:

- Hetzner requires a snapshot and server type to have the same architecture.
- Snapshots are not location-bound and can create servers in any listed location, but server-type availability and deprecation are location-specific.
- The snapshot image exposes `disk_size`; Hetzner disks cannot shrink, so the requested server root disk must be at least the snapshot requirement.

**Alternatives considered**:

- Key only by image ID: rejected because provider IDs do not encode boot/update compatibility.
- Duplicate every snapshot for every Hetzner location: rejected for V1 because official docs say snapshots are location-independent; region remains a rollout/availability constraint rather than duplicate storage when policy permits.

## Decision 5: Retain below quota and protect in-use images with DB leases

**Decision**: Default retention is configurable and must remain below the project's effective snapshot quota. V1 defaults to 20 retained snapshots, leaving headroom below Hetzner's documented default of 30 across all projects. A snapshot referenced by a promoted channel, rollback window, active lease, or only-compatible fallback cannot be deleted.

**Rationale**: Hetzner documents a default limit of 30 snapshots across all projects and never automatically deletes snapshots. Quota pressure must not trigger unsafe deletion.

**Alternatives considered**:

- Always retain every bundle snapshot: rejected because storage and count are bounded.
- Delete oldest by timestamp only: rejected because it can remove promoted, rollback, leased, or sole-compatible images.

## Decision 6: Make cloud-init freshness an explicit validation gate

**Decision**: Sanitation removes cloud-init cache/instance state and persisted user-data. A validation clone must prove fresh activation and new machine/SSH identity before readiness.

**Rationale**: Hetzner injects selected SSH keys and access configuration through cloud-init when creating from official-image-derived snapshots, while any keys already present in the snapshot continue to work. This makes removal of builder keys and fresh cloud-init execution mandatory.

**Alternatives considered**:

- Keep builder cloud-init state and run a custom first-boot unit only: rejected because it creates two initialization sources and risks skipped provider network/SSH initialization.

## Decision 7: Exclude attached volumes and container state

**Decision**: Builders use only their root disk. Sanitation deletes Docker/container volumes and state even if present. Validation rejects mounted/initialized owner data.

**Rationale**: Hetzner snapshots do not include attached Volumes. Depending on a volume would make the image incomplete; retaining Docker volumes on the root disk risks database/customer-like state.

**Alternatives considered**:

- Snapshot an attached data volume separately: out of scope and incompatible with the approved single-image V1.

## Decision 8: Separate eligibility from mutable channels

**Decision**: Enqueue keys use bundle SHA-256 plus compatibility key. Main/tag publication triggers enqueue; channel promotions reuse the existing identity. Preview artifacts are excluded unless an explicit bounded test flag is present.

**Rationale**: Channel pointers are mutable, while the snapshot must prove immutable bundle provenance and support rollback without creating channel duplicates.

**Alternatives considered**:

- One snapshot per channel: rejected because promotions/rollbacks would duplicate identical images and make provenance ambiguous.

## Undocumented behavior spike matrix

| Question | Current evidence | Implementation dependency | Live disposable spike gate |
|---|---|---|---|
| Delay between Action success and `image.status=available` | Not guaranteed | Poll both with separate bounded deadlines | Measure p50/p95 and visibility lag |
| Label visibility after lost create response | Labels accepted by official create APIs; propagation latency not guaranteed | Retry exact lookup with backoff; never create while ambiguous | Drop client response after accept and reconcile |
| Image DELETE timeout convergence | No atomicity guarantee | Keep `retiring`, GET exact ID until absent | Inject timeout and verify eventual state |
| Snapshot cloud-init rerun after cache reset | Provider docs describe cloud-init injection, not Matrix script behavior | Validation clone must prove callback/identity | Build one disposable image and clone twice |
| Cross-location capacity from a snapshot | Supported in docs; capacity is dynamic | Location/provider rejection falls back | Try configured supported test locations |
| Server ID followed by Action allocation failure | Explicitly documented | Persist Action and reconcile/delete | Fake-provider fault test; optional live capacity test only if safe |

Until the separately authorized live spike passes, rollout remains disabled. No V1 correctness claim depends on a favorable answer: all ambiguous/unsafe paths quarantine or reconcile and fall back.
