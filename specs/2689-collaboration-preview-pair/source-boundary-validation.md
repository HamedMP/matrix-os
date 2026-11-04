# Source profile and authority checkpoint

[ENG-418](https://linear.app/matrix-os/issue/ENG-418) remains In Progress.
These ports prepare configured startup; they do not create a live environment.

## Boundaries and invariants

The source profile names six numeric immutable Secret Manager versions, a dedicated
Preview identity, prepared database/role, cloud service and storage prefix. Fixed
Google metadata/Secret Manager HTTP checks deadlines, redirects, returned resource
name, canonical base64, CRC32C and UTF8. No candidate URL receives these credentials.
Resolved host/JWT/edge values cannot reuse each other, issuer material or source
privileged credentials (including operator/bank/Clerk/provider/GitHub values). Signing seeds are compared as decoded bytes against control active/retired
keys. Existing Clerk organization readers remain the identity source of truth.

Target construction never runs migrations. Admission/activation separately check
actual database/role/grant isolation and required tables. The source can retain
provider/cloud retirement during a target outage. Its owned pool closes even if
Kysely has not initialized its driver; injected/source pools remain caller-owned.

Authenticated cloud observations must match every independently resolved secret
field/version. Current request lookup distinguishes close/label removal from an
unavailable response. A live proof must match the canonical full UUID/generation,
not just a public short tag. The request label is `preview-collaboration-pair`.

A non-authorizing public source-profile fingerprint is recorded in each admitted
candidate. Configured admission requires it before provider reads. Cleanup rejects
an absent/different fingerprint before contacting the configured cloud boundary;
a404 from a replacement project/service cannot release an older lease. Restore the
recorded reviewed profile to retire its generation before changing that boundary.
Operator credential rotation leaves the resource fingerprint unchanged. The current
origin contract requires the `matrix-platform-preview` service family; setup
rejects an unsupported family rather than handing off unusable origins.

## Regression evidence

- Cross-domain key tests first accepted source Clerk/provider/GitHub credentials
  as a host key, issuer material as a host key, and control JWT material as a
  signing seed. A noncanonical encoded host/JWT alias also passed. All are now
  rejected by material-aware checks across the source private credential domains.

- Cloud Run previously accepted a different numeric secret version or swapped
  approved host/JWT reference. Both actual reader tests resolved before the fix.
- Missing configured profile fingerprints previously passed provenance checks;
  a wrong-boundary404 was accepted as absence. Both now fail closed. Matching
  profile observations remain accepted. An earlier changed-field test initially
  hit the old strict candidate schema; that is not counted as the profile guard.
- Actual target SQL proves a separate role/database, rejects an unprepared schema
  without creating tables, and preserves independent caller-owned connections.
- The composed startup tests additionally exposed Kysely's uninitialized-driver
  behavior: destroy alone allowed a later query to open the owned pool. Explicit
  owned-pool shutdown fixes it. The failed attempt also failed fixture teardown;
  it is not a qualified result. Its disposable server volume is task-owned.

## Qualification and limitations

The combined final source checkpoint passed125 tests across13 suites with zero
skips/unhandled errors and process exit0. It includes these ports, existing cloud,
config/provenance/identity checks and the dependent actual startup wiring. The
four-file lifetime subset passed15/15. Strict SQL inventory contains80 files in
the complete startup tree; the parent port layer contains78 before its two startup
suites are added. The source port layer independently passed112/112 tests across10 suites with
zero skips/unhandled errors, including its own uninitialized-pool protection.
An additional focused authority run passed2/2 after the actual profile-drift
assertion. All eight native TypeScript projects passed; the final platform-only
credential edits passed a targeted platform check. The isolated parent platform typecheck also passed (exit0). Committed-source
pattern results are recorded in its PR.

Google/GitHub/Clerk HTTP facts, provider servers, object storage and resolved secret
values are explicit fixtures. Postgres, canonical SQL, real producer/consumer
readers and pool ownership are real. No normal login, paid VPS, cloud mutation,
Chat prompt, screenshot or live Web Desktop/Electron Desktop qualification is
claimed. Numeric references and service-account names do not prove effective IAM;
reviewed protected setup and actual-target isolation remain activation gates.
