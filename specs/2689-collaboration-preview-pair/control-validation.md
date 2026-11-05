# Authenticated control transport and artifact handoff

[ENG-418](https://linear.app/matrix-os/issue/ENG-418) ·
[native stack3026](https://github.com/HamedMP/matrix-os/stack/3026) ·
parent [publisher #3050](https://github.com/HamedMP/matrix-os/pull/3050).

This is an implementation component. The protected workflow/user command,
pair-only bundle classification, Electron launcher, actual-target qualification
and documentation remain unfinished. T016/T033 stay open. No cloud/VPS activation,
customer update, permission change, merge or deployment occurred.

## Verified behavior

- Real control-issuer/current maintainer setup returns only the reviewed controller
  identity/ref, verified requester and admission flag. Preview identities and
  outsiders cannot obtain it. The actual fixed-origin client is tested against
  production Hono routes and real Postgres; user and operator tokens remain distinct.
- Preparation reuses an existing PR pair under the admission/row lock, records
  currency and gives a new run no cancellation ownership. Private status is bound
  to the exact recorded run and effective generation; an earlier run cannot poll
  the target reset as its own. Current maintainers can stop one revision-fenced
  generation through normal authentication with a16KiB streaming body limit.
- Update adoption repeats controller, membership, publication and candidate proof
  before a DB-only transaction checks immutable parent generation/source. Progress
  revisions cannot invalidate an otherwise unchanged selected parent. The existing
  writer still enforces revision in SQL under the row/admission lock, and exact
  replay returns the same adopted generation without another reset or grant.
- The actual source adapter observes reviewed controller completion. Unadopted
  terminal runs retire; successful adopted runs remain. Failed/cancelled runs
  retire the effective target during update. Missing, inconsistent or unverified
  provider facts remain unknown. Close/removal/supersession can still retire without
  waiting for a controller read. Source shutdown ownership is unchanged.
- The pre-credential origin verifier checks the actual run/ref/workflow SHA,
  attempt/actor, pinned branch and commit tree; it rejects a Main ancestor. It is
  a tested helper, not an already deployed workflow or proof of protected setup.
- Artifact reads bind authenticated metadata and exact archive bytes, omit the
  bearer from signed storage, reject traversal/duplicates/unsafe paths and create
  only regular files. Streaming limits:3GiB archive,6GiB expanded,50,000 entries,
  16KiB input batches,16MiB batch output,256 events and32 open handles. Invocation
  collections are capped and discarded/evicted. Output remains quarantined until
  digest and ZIP/ZIP64 footer verification; failures and explicit disposal close
  handles and remove only the inode/dev-owned directory.

## Fault evidence and results

Intended assertion failures preceded these corrections:

- Missing setup returned400 rather than200/403; missing status returned404.
- Existing-pair preparation returned409 rather than canonical202 reuse.
- Missing maintainer stop/adoption returned404 instead of the scoped outcomes.
- A completed unadopted controller and a cancelled adopted controller still looked
  requested. During reset, inspection incorrectly read the previous successful run.
- A completed run without a conclusion was treated as a known cancellation;
  it now remains an upstream-unavailable observation.
- An independent Python standard-library ZIP64 writer produced a valid archive
  rejected by the footer verifier. Forced ZIP64 may retain unsaturated classic
  fields; agreement with the ZIP64 record is now checked correctly.

The initial new artifact implementation admitted metadata but could not complete
download; its positive/progress assertions failed before transport/extraction.
Module-resolution and sandbox Python-spawn failures are setup failures and are
excluded from regression evidence. The new contract aliases were registered;
the independent ZIP64 assertion was rerun with subprocess access before its fix.

Qualification: **45 tests/4 suites passed** for routes, source controller ownership,
retained update behavior and artifact handling; **39 tests/3 suites passed** with
the actual controller-client/router/DB journey. Final artifact/origin qualification:
**25 tests/2 suites passed**, no skips/errors, including the independent ZIP64
producer and same-length corrupted archive digest case. Counts overlap.

All **8 native typecheck projects passed**, using unchanged project/compiler
configuration with the local extended deadline and one768MiB Go worker. An explicit
script project also typechecked all new TypeScript transport files. The committed-head pattern
audit passed with zero violations and one reviewed warning: all listed body reads
are behind the shared16KiB streaming body-limit middleware; reader stop has its
own matching middleware and a413 regression assertion. The strict SQL inventory remains86 files;
new SQL assertions extend already registered suites. Python is only a test archive
producer, with its ZIP64 threshold deliberately forced; it supplies no auth bypass.

One existing fflate version is declared explicitly at the root for fresh script
installs:0.8.3. Shared validation uses the existing contracts package. The normal
pnpm10.33.4 install kept minimum release age, and the lock diff adds only its root
specifier/resolution; unrelated peer/version changes were discarded before install.

The read-only real artifact probe did not qualify a managed archive: direct
`GET https://api.github.com/repos/HamedMP/matrix-os/actions/artifacts?per_page=100`
returnedHTTP500. An earlier CLI read returned an empty/invalid response. No further
probe or provider workaround was used. No credentials or artifact contents were
printed, executed or committed. Provider HTTP, identity and candidate authorities
in the deterministic qualification remain explicit fixtures.

## Remaining delivery

Finish scoped bundle publication and the protected workflow before claiming a
working create/update command. Keep retired request identities as tombstones; a
cancelled pre-admission identity cannot be reused by another controller. An old
reproduction stays intact; a fresh attempt may require explicit stop/new pair.
Actual Google/IAM isolation, paired VPS boot, supported desktop artifacts and
Web Desktop/Electron Desktop captures remain required feature qualification.
No rendered OS surface changed here and no visual qualification is claimed.
Recommend collaboration/platform and Preview infrastructure owner review.
