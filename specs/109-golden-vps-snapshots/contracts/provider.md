# Contract: Snapshot Provider

The domain service depends on an injected provider interface. All provider methods validate bounded IDs/labels and use a 10-second HTTP request timeout. Poll loops use operation-specific deadlines and bounded exponential backoff with jitter.

```ts
interface GoldenSnapshotProvider {
  createBuilder(input: CreateBuilderInput): Promise<ProviderServerOperation>;
  createSnapshot(input: CreateSnapshotInput): Promise<ProviderImageOperation>;
  createValidationClone(input: CreateCloneInput): Promise<ProviderServerOperation>;
  createCustomerClone(input: CreateCloneInput): Promise<ProviderServerOperation>;
  getServer(id: number): Promise<ProviderServer | null>;
  shutdownServer(id: number): Promise<void>;
  powerOffServer(id: number): Promise<void>;
  listServersByExactLabels(labels: Record<string, string>): Promise<ProviderServer[]>;
  getImage(id: number): Promise<ProviderImage | null>;
  listImagesByExactLabels(labels: Record<string, string>): Promise<ProviderImage[]>;
  getAction(id: number): Promise<ProviderAction | null>;
  deleteServer(id: number): Promise<void>;
  deleteImage(id: number): Promise<void>;
  validateCompatibility(input: CompatibilityProbe): Promise<CompatibilityResult>;
}
```

Required provider values are parsed from `unknown` with bounded Zod schemas before reaching domain code.

## Immutable labels

Every builder, validation clone, and image receives:

- `app=matrix-os`
- `matrix_resource=golden-snapshot`
- `snapshot_id=<uuid>`
- `build_id=<uuid>`
- `snapshot_role=builder|validation|image`
- `compatibility_key=<first 32 lowercase hex characters of compatibility_key>`
- validation clones additionally receive `validation_ordinal=1|2`

Hetzner label values are capped at 63 characters. The provider label therefore uses
only the fixed 32-character digest prefix; the full 64-character compatibility key
remains authoritative in Postgres and exact reconciliation verifies the full snapshot
and build UUID tuple in addition to the bounded prefix.
The validation ordinal is part of every validation-clone create, lookup, adoption,
and cleanup query. This keeps clone 1 and clone 2 independently reconcilable when
deletion of the first clone and creation of the second clone are both ambiguous.

Customer clones retain the existing `machine_id`, owner, and runtime-slot labels plus `snapshot_id` when used. Reconciliation requires the complete expected tuple; partial matches are not adopted or deleted.

## Actions and readiness

- HTTP acceptance is not completion.
- Action statuses are `running`, `success`, or `error`.
- Images are usable only when the create Action is `success` and image status is `available`.
- Servers are usable only when the create Action succeeds; customer routing still waits for Matrix registration/health.
- Builders must be quiesced with graceful shutdown, followed by bounded status polling;
  if shutdown does not converge, use hard power-off and prove `off` before capture.
- A customer or recovery server whose authority is uncertain must be proven `off` by
  `getServer` after shutdown/power-off, or separately network-isolated with its exposed
  credentials revoked, before a successor can become authoritative. Delete acceptance
  alone is not proof of isolation.
- Missing/unknown Action or resource state is ambiguous and non-selectable.

## Compatibility

- Image architecture must equal requested server-type architecture.
- Requested server type must be offered in the configured location and not past its location-specific deprecation/unavailability boundary.
- Server disk size must be greater than or equal to image disk size/minimum disk.
- Snapshot location storage is not treated as a creation restriction because Hetzner documents snapshots as usable across locations; live capacity rejection still triggers fallback.

## Deletion

- Resolve exact ID and immutable labels immediately before deletion.
- Protected/mismatched resources are not force-unprotected/deleted automatically; quarantine for operator review unless the lifecycle row proves Matrix ownership and policy explicitly authorizes protection removal.
- A DELETE timeout is ambiguous. Continue GET/reconciliation; do not create replacement canonical state based only on the timeout.
- `404` on exact-ID reconciliation is idempotent deletion completion.

## Error mapping

Provider details are logged server-side with redaction. Domain codes are bounded to values such as `quota_exhausted`, `capacity_unavailable`, `image_missing`, `image_incompatible`, `action_failed`, `operation_timeout`, `provenance_mismatch`, and `provider_unavailable`. Customers receive only existing generic provisioning errors.
