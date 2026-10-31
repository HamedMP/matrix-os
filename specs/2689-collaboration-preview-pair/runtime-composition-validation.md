# Runtime composition checkpoint

ENG-418 remains In Progress. This layer assembles the real runtime mechanisms;
configured Platform startup, controller automation, Electron, normal-login
acceptance and the public-site documentation PR remain open. No paid VPS or
cloud mutation has been performed.

## Boundaries exercised

The composed lifecycle uses real Platform Postgres transactions, durable provider
jobs and rendered cloud-init, isolated non-superuser target Postgres, projection,
the existing candidate registration producer and bounded test-credit policy.
The test reads the registration token from the actual rendered bootstrap because
the real dispatcher clears its consumed encrypted payload. It verifies both
registrations are adopted, both jobs complete, no funding is allocated before
both register, and unrelated customer state is preserved.

Provider servers/IPs, Cloud/GitHub/controller identity facts and funded-host HTTP
are explicit fixtures. Host restart stays pending in the funding fixture; this
does not claim ready infrastructure, a normal Clerk login, a working Chat prompt
or any live Web Desktop/Electron Desktop surface.

## Regression evidence

- Admission-off maintenance initially disabled the profile/report routes and
  failed to stop preparing/queued work; a real update advanced a new generation.
  Actual admission/update producers establish those states. The real HTTP report
  returned503 instead of200. Maintenance now denies start/update before controller
  or provider calls while retaining authenticated reports, stop and retirement.
- Bank-off construction initially prevented cleanup. Missing bank capability now
  denies admissions before writes and leaves retirement available.
- Queue-only composition initially left the two simulated servers live. The
  composed runtime now drains only its owned pair jobs through the extracted
  existing deletion consumer, independently verifies provider absence, and leaves
  an older customer deletion request pending. No broad customer reconciliation is
  invoked. The ordinary consumer retains its default behavior and backoff.
- A real claim-expiry race initially issued DELETE after provider verification
  crossed the claim deadline. A final claim check before the destructive call
  prevents it; the durable deletion and fixture lease remain pending.

Fresh identity checks reuse the real Clerk organization client with explicit
HTTP fixtures. Control/test instances and keys remain separate; outages cannot
be mistaken for an outsider denial. Publishable-key parsing was checked against
the installed first-party @clerk/shared version3.47.7 producer/parser. No organization
state system, cache, permission mutation or generated peer session was added.

## Qualification

72/72 assertions across9 focused files, zero skips or unhandled errors, exit0:
36 assertions use real Postgres;17 retain the existing customer fixture;19 are
configuration/identity unit assertions. All8 native typecheck projects pass.
The strict required Postgres inventory contains76 files. Committed source pattern
results are recorded in the PR after the checkpoint commit. Full required-SQL,
production shell/Electron builds and live captures remain delivery gates.

Some initial attempts were fixture errors and are not regression proof: an
invalid synthetic updating row, accidental same-PR singleton reuse, invalid
synthetic Clerk organization IDs, decrypting an already-erased job payload and
an incomplete provider mock missing authoritative inventory. Those fixtures were
corrected to use real producers/contracts; no production guard was weakened.
