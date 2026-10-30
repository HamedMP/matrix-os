# Source-owned Preview publication

Tracking: [ENG-418](https://linear.app/matrix-os/issue/ENG-418).
Native stack: <https://github.com/HamedMP/matrix-os/stack/3026>.
Parent: [pre-admission recovery #3049](https://github.com/HamedMP/matrix-os/pull/3049).

This layer supplies the actual source publisher and pre-admission diagnostics.
The protected workflow and paired Electron launcher remain dependent work;
T016/T033 remain open. No cloud resource or paid runtime was changed for validation.

## Boundary and invariants

The protected request accepts an image digest, generation and recorded controller
run. Current reviewed-controller identity, maintainer membership, dedicated test
membership, target isolation and eligible PR source are checked again. Repository,
service, runtime account and immutable secret versions come only from the approved
source profile. The optional image repository must be dedicated to Preview and is
part of its public fingerprint. A legacy profile can still diagnose and retire its
recorded requests; it cannot publish without an approved repository.

The publisher independently reads the exact
[Artifact Registry image](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.dockerImages/get)
and ready existing Cloud Run service. It whitelists the candidate template rather
than copying source environment, mounts or sidecars. Exactly six pinned secret
references reach the runtime; no operator, provider or control credential is copied.
The produced environment is exercised through the real runtime-profile consumer.

Before the single
[service update](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch),
the source commits the immutable digest and publication nonce under the admission
lock. No network call is inside that transaction. Desired `LATEST` allocations are
frozen to their observed revisions before adding two zero-percent tags. Existing
traffic, IAM and ingress remain unchanged. Missing/ambiguous service state, tag
collisions, incomplete operation discovery and unexpected revisions stop issuance.

A definite rejected request is recorded; ambiguous transport/5xx/acknowledgement
failure stays issuing and cannot repeat the mutation. A complete authenticated
operation inventory can recover only the exact service/full UUID/generation/source
and nonce receipt. Empty or unsupported discovery does not prove absence. A
publication cannot become ready until its known operation succeeds and the real
immutable revision authority proves the selected image, identity, routing and
secret bindings. Cancellation retains a late receipt without reopening the request.
An unadopted update whose parent stops or advances is retired independently and
cannot release the parent's fixture lease.

The ordinary and exact-generation request reports expose finite safe states to
the verified control requester or current maintainer. They return no operation
resource, nonce, claim, raw provider error, manifest or content capability. A
Preview-issuer actor with the same identifier and an unrelated outsider are denied.

The additive revision5 migration adds one nullable digest and one format check.
Legacy ambiguous publication records are never guessed/backfilled. A capture from
the disposable PostgreSQL16 fixture retained every earlier schema record unchanged.

## Named faults and qualification

Observed assertion failures before their corrections:

- Request reports returned404 before an admitted pair existed; invalid generations
  also returned404 instead of boundary-validation400.
- Publication routing returned404 instead of protected202/strict400 responses.
- The configured runtime omitted the publisher's build context and readiness gate.
- A late acknowledgement carrying its separately validated digest was rejected at
  an internal strict-schema boundary rather than retaining its original receipt.
- The immutable revision proof omitted the selected image.
- An unadopted update remained prepared after its parent entered cleanup.
- Malformed provider JSON escaped as a Zod error, misclassifying an upstream
  outage as a bad client request; it now maps to typed generic unavailability.

The first publisher implementation also exposed a strict-schema mismatch in its
internal payload handoff; all seven initial provider/journal cases then passed.
An expanded run passed startup and composition but four publisher fixture setups
failed under shared-host contention (30s setup/5s migration-lock timeouts); these
are not counted as product regressions or passing qualification. The overlapping
full typecheck hit its gateway compiler180s timeout. Subsequent qualification is
run serially. The publication/recovery/journal/request/operation cohort passed
**51 tests/5 suites, exit0**, without skips or unhandled errors. Retained schema,
profile/payload and canonical service qualification passed **84 tests/8 suites,
exit0**, without skips or errors. The configured startup/runtime composition
suites also passed their **11 cases** in the earlier expanded run; its four
publisher setup failures remain excluded. All **8 native typecheck projects passed,
exit0** using the unchanged project configurations and compiler runner with a local
15-minute per-project deadline, one Go worker and a768MiB Go memory limit. Two
earlier canonical180s runs timed out at gateway under severe shared-host contention;
no repository timeout policy was changed. Pattern audit: **0 violations,
3 reviewed warnings**, exit0. Every mutating route shares the16KiB middleware;
the transient Set is capped by the128-entry revision schema; the path heuristic
matched two promise helpers, which perform no filesystem operation.

The tests use real dedicated PostgreSQL and production adapters with explicit
Google/Clerk/GitHub HTTP or verified-reader fixtures. They prove neither actual IAM
isolation nor a live Cloud Run deployment, VPS boot or collaboration journey.
After the final provider-error correction, all **9 publisher cases passed, exit0**,
with no skips/errors. These runs overlap and are not additive assertion counts.
The focused SQL manifest includes both new suites (86 total files).

## Readiness and evidence

Protected setup, controller registration, actual-target isolation, live desktop
artifacts, Web Desktop/Electron Desktop acceptance and captures remain required.
No screenshots, recordings, Slack post, cloud activation, merge or deployment is
claimed. Recommend collaboration/platform and Web/Electron owner review. The
public-site documentation remains its separate ENG-418 deliverable.
