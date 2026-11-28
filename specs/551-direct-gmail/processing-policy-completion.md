# Google processing policy completion

ENG-355 completes configuration and review tooling for managed and owner-supplied AI. Both kinds remain subject to exact current route/account/harness/credential bindings, reviewed recipients, purpose and retention controls, owner consent and server-produced processing envelopes. Passing tests or possessing an OAuth token grants none of those authorities.

## Operator profile review

`packages/gateway/src/google-data/operator-review.ts` provides a privileged, dry-run-by-default review operation. No public review route is registered. The operator supplies a strict profile, raw evidence manifest bytes, an independently expected manifest SHA-256 and an expected registry revision. Existing rows also require their exact UUID in both profile and manifest; creation requires revision zero and a null manifest profile ID. The repository performs the existing owner-scoped conditional write inside its transaction. The command does not migrate schema, seed consent, enable inference or change production routing.

The canonical subject digest sorts object keys, preserves array order and includes the full profile, including `evidence.referenceDigest`. That reference is a common provider evidence bundle digest, independent of owner approval metadata. Compute it as SHA-256 of the UTF-8 JSON array of exactly five records in this role order: `terms`, `account-settings`, `route-probe`, `data-handling`, `deletion`. Each record has exactly the keys `{kind, path, sha256}` in that order. Filenames and roles are unique. The manifest's `providerEvidenceDigest` and profile's `evidence.referenceDigest` must both equal this digest. The managed route descriptor uses that same common evidence reference, allowing multiple independently reviewed owner profiles to resolve one qualified route.

The exact raw manifest bytes have a separate SHA-256, supplied independently as `--expected-manifest-sha256`; the raw hash is never the profile's evidence reference. This avoids a circular hash while binding the complete reviewed profile. Each owner-bound manifest includes the subject digest, common evidence digest, target UUID/revision, owner, human reviewer, review time and expiry. Every approved model needs one observed route with the same exact ordered recipient chain, account, credential kind/generation/fingerprint, endpoint and harness revision. Unknown fields, extra/missing roles, duplicate files/routes, changed policy inputs and stale/future evidence are rejected. Evidence expiry is bounded to one year, matching the registry.

SHA-256 establishes artifact integrity, not truth, contractual coverage or provider approval. A responsible reviewer must establish the actual account settings, applicable provider agreements, permitted models, onward recipients, retention/deletion behavior and successful matching route probes before signing the manifest. Synthetic fixtures cannot qualify real accounts. Changes to credentials, routes, recipients, policies or model selection require fresh matching evidence and any affected owner consent; the tool does not infer equivalence.

## Manual command

Use `bun scripts/google-data-review-profile.ts` with these mandatory arguments:

- `--evidence-dir <absolute canonical private directory>`
- `--profile <profile.json>` and `--manifest <manifest.json>` (flat filenames within that directory)
- `--expected-manifest-sha256 <independently reviewed lowercase SHA-256>`
- `--expected-revision <0 for create, current revision for update>`

Without `--apply`, validation runs without creating a database pool or writing the registry. An optional `--receipt <new filename>` records a dry-run result. Applying additionally requires `--apply --database-host <exact host> --database-name <exact database> --receipt <new filename>` and the explicit `MATRIX_GOOGLE_REVIEW_DATABASE_URL` environment variable. The command accepts no general `DATABASE_URL` or dotenv fallback. URL host/database must match the pins, the port must be PostgreSQL's default, TLS mode is required and URL routing overrides are rejected. Never include a credential-bearing URL in a command argument or evidence document.

The evidence directory must be canonical, owned by the operator and mode `0700`. Profile, manifest and artifacts must be bounded regular files, mode `0600`, without symlinks, hard links or nested paths. Reads are capped at 1 MiB even if a file grows. Receipt creation is exclusive (`wx`, mode `0600`) before applying a database write. A pending receipt after interruption requires owner-scoped registry inspection and reconciliation; do not blindly retry. Pending and final receipts are published by fully writing and syncing a new exclusive private sibling file, checking the current receipt and directory identities, then atomically renaming it. Pre-publication write or rename failures preserve the pending bytes. Replacement or symlinked reservations are rejected, and only the operation's exact temporary file is cleaned up. Existing evidence and receipts are preserved. The script closes its own repository and pool; it never closes an externally supplied shared pool.

## Authorization and verification

| Entry point | Authority | Side effects |
| --- | --- | --- |
| Operator dry-run library / CLI | Trusted local operator with private evidence files | Validation and optional new receipt only |
| Explicit CLI apply | Same operator, explicit review database URL and host/database pins, manifest target/revision | One existing repository CAS review transaction; fresh exclusive receipt |
| Existing owner disclosure/consent API | Authenticated owner | Existing owner-scoped consent behavior; no profile approval |

Tests cover complete evidence, role/hash substitution, target/CAS binding, exact-model route constraints, evidence dates, directory/file boundaries, exclusive receipts and command routing pins. Run tests, builds and dependency work remotely. Hosted current-head CI, independent review, exact deployed bundles and live evidence remain separate gates.

The supported web onboarding adapters reuse `GmailConnectionChoice`, preserve Matrix/Pipedream selection and require the exact receipt account when a receipt is supplied. Native Apps and Settings share their existing native chooser and receipt adapter. Physical Native Mobile remains explicitly deferred by the requester. Provider account qualification, real owner consent/read/parity/revocation/deletion/replay, public policy publication and assessor review require their actual evidence; this implementation alone is not an audit-readiness claim.

Public documentation is a separate deliverable in the private `FinnaAI/matrix-os-site` repository (existing related draft PR #287). Keep private account IDs, route evidence, credentials and operator receipts out of this repository and public documentation.


## Stateless Responses history

The governed OpenAI Responses path is tested with the pinned Pi SDK's actual `convertResponsesMessages` output, through the broker. Full inline assistant text and function-call history are supported. Bounded assistant item IDs, completed status, empty annotation arrays, presentation phase and function-call item IDs are normalized away; content, function names, arguments and call IDs remain intact. No ID becomes a provider-side item reference. Nonempty annotations, namespaces, unknown metadata, `previous_response_id`, remote `item_reference`, hosted/custom tools and encrypted or opaque reasoning replay remain unsupported and deny before dispatch. Models or features requiring those forms need a separately reviewed adapter; support is not inferred from model discovery.
