# Manifest, desktop context and local launch contract

Tracking: ENG-418. This is a non-authorizing handoff. Membership, real user login
and owner-runtime/project authority continue to decide every product operation.

## Canonical manifest v1

Strict object, max64KiB:

- `schemaVersion=1`, UUID `pairId`, positive `generation`, positive `pr`, fixed
  `repository`, lowercase40-character `sourceSha`, UTC `createdAt` / `expiresAt`.
- `state=ready`, separate `outdated`, `organizationId`, approved Preview identity
  issuer, exact fixed HTTPS `platformOrigin` and `apiOrigin`.
- Exactly two `members` keyed `owner` and `member`: expected actor ID, machine UUID,
  handle, identical nonprimary runtime slot, actual installed/running source and
  version, live enrollment generation and readiness observations. All identities
  are distinct as required; neither member has blanket peer-computer access.
- `desktopArtifacts`: <=8 supported target records with OS/architecture, exact
  repository/workflow/run/artifact identity, sourceSHA, artifact SHA256/size and
  expected contained executable/archive format. Trusted canonical storage obtains
  digests independently from the verified build/run; no arbitrary download URL.
- Verified platform/host component provenance, explicit data policy/reset state,
  test allowance expiry and bounded evidence/report references.

Reject unknown fields, unsafe strings, duplicates, secrets and prototype-shaped
role keys. A manifest-supplied checksum cannot establish its own provenance.

## Proposed local command

`bun run preview:pair:open -- --pair <uuid> --profile <trusted-control-profile>`

Optional local manifest input is merely a selector/cache; the launcher still reads
the canonical active generation through the configured first-party authenticated
CLI profile. Profile selection uses existing normal auth providers in memory;
credentials never enter argv, context files or logs. A supplied manifest origin
cannot redirect that bearer. Unsupported targets fail before executable launch.

An explicit artifact path may point to bytes already obtained through the trusted
GitHub run download. It is validated against the canonical artifact/run/source and
digest exactly like a fresh download; it cannot silently use the installed app.

## Launch lifecycle

1. Strict-parse the handoff; retrieve and authorize the canonical live generation.
2. Independently verify repository, immutable workflow/run source, target, digest,
   expiry and exact allowed platform/identity origins. Fail before any candidate
   request on a mismatch; no production or primary-computer fallback.
3. Download/extract into a fresh owned temp directory, checking byte/file caps,
   traversal and symlink/link destinations before writes. Do not run archive hooks.
4. Create separate pair/generation/role profiles under an owned preview root,
   with restrictive ownership marker/context files. Refuse traversal, symlink or
   unowned pre-existing directories; never touch the normal Electron profile.
5. Launch the exact artifact executable twice directly, with distinct userData and
   sessionData and a bounded non-secret expected context. Repeated launch reuses
   each role's lock/profile. Track child handles; partial failure stops only new
   children and cleans only their owned temporary state.
6. Each app checks embedded source and expected actor/origin/handle/slot before
   persisting or using cached/new credentials. An unselected fresh token exchanges
   only for its expected preview runtime; exchange failure must not select primary.
7. Normal real device polling authenticates each test account. Wrong browser identity
   leaves a mismatch and no business request. Callback focus cannot authenticate or
   change another profile; Preview mode does not register global auth schemes.
8. The existing organization store verifies current membership/active selection.
   Display role, candidate, expected/actual computer and organization clearly.
9. Pair mode disables all update checks/download/install/menu paths. Closing local
   apps does not destroy the cloud pair. Explicit scoped profile cleanup is available.

## Evidence contract

Each scenario records pair/generation/source, exact host/platform/desktop artifacts,
actor role, surface, step, transport, result `pass|fail|not_run`, timestamp and safe
capture/diagnostic references. Cases: creation opt-in; later first Share; pending
member discovery/acceptance; inherited prompt/reopen; outsider denial; owner restart;
revocation; failed publication stays private. No raw bearer, cookie, private path,
customer content or unchecked provider string. Captures are attached/linked outside
Git; expiry and any synthetic provider/auth/service boundary are explicit.

A fake gateway can verify actual local Electron session isolation only. It cannot
qualify real Clerk, cloud runtime/control stream, transaction authority or model
response. Real Postgres and real two-account live qualification are separate required
lanes. Missing artifact/display/identity/configuration cannot silently skip a required
lane or be converted into a passing product scenario.
