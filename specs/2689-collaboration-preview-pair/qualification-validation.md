# Preview-pair qualification

[ENG-418](https://linear.app/matrix-os/issue/ENG-418) ·
[native stack](https://github.com/HamedMP/matrix-os/stack/3026) ·
[parent launcher #3088](https://github.com/HamedMP/matrix-os/pull/3088) ·
[public docs #322](https://github.com/FinnaAI/matrix-os-site/pull/322).

## Implemented behavior

`preview:pair:qualify` reads the ready manifest through the normal authenticated
Source profile, creates a private observations template and waits while an
operator tests the normal account UIs. A final Source read fences the pair,
generation, source SHA and PR. It does not create grants, publish a scope,
impersonate a peer, provision a computer or post evidence externally.

Eight scenarios on Web Desktop and Electron Desktop start as `not_run`.
Bounded observations reject wrong roles, duplicates, incomplete passes, source
changes, future timestamps, unknown fields and credential-bearing capture URLs.
A reported live pass requires screenshot and recording links. Missing cases
stay pending; fixture results never count as live acceptance. All manual reports
require review. Exports are private, exclusive and atomic; existing files survive
failure. There is no new database, endpoint or authorization authority.

`preview:pair:qualify:fixtures` executes eight retained first-party component,
client/relay, owner-runtime and authorization suites, including inherited project
prompt execution. It requires a clean checkout at the full requested SHA and an
explicit disposable loopback Postgres. The actual Vitest JSON producer must
contain passed assertions in every selected file. Missing, skipped, empty,
duplicate, foreign or inconsistent results fail collection.

Fixture children receive a temporary HOME and a small environment without Root,
cloud, GitHub or model credentials. This is local execution, not an OS sandbox;
the selected candidate must be reviewed before running it.

## Completed checks

| Check | Result and exact boundary |
| --- | --- |
| Export, evidence and fixture collector | 24 tests / 3 suites passed |
| Actual fixture command | 70 assertions / 8 suites passed on clean `72d3bec44c3bc5dc4003da80437e5fc42ec7b55a`; receipt explicitly says fixture and productAcceptance=not_run |
| Preview platform qualification | 515 tests / 63 suites passed in 485.85s against disposable Postgres 16; 88-file SQL inventory has no drift |
| Repository typecheck | Official `bun run typecheck`: all eight projects passed after normal Observability/Kernel/Integrations prerequisite builds |
| Production shell | Canonical production build passed; nine static pages generated |
| Production Electron and native fixture journey | Passed at parent `1c20a06667dc4a7d8348b78c9a072d5519443b30`; real Main/preload/renderer/AuthService with explicit Source/provider transport fixtures |
| Patterns and React audit | Expanded qualification scan: zero violations, one reviewed path warning; parent React comparison: zero new diagnostics |
| Public docs | Hosted test check passed; focused metadata/docs/layout checks 4/4 passed; hosted responsive checks passed at 375/768/1280 |

Regression red evidence includes three positive evidence cases, the guided
export case, current-PR drift and a collector prototype fault replay. Syntax/load
failures do not count as regression evidence. No additional tests were needed for
the final documentation edits.

The fixture receipt is outside Git at
`/tmp/eng418-qualified-output/fixture-72d3bec44c.json`. It proves deterministic
first-party authorization and inherited-prompt boundaries, not a real model
response. Postgres fsync was disabled locally: these are logical transaction
checks, not power-loss qualification. The native Linux fixture uses Playwright's
`--no-sandbox` launch flag; the production launcher does not add it. Real Clerk,
keychain, GCP, macOS and model behavior remain unqualified.

Earlier full-typecheck resource timeouts are superseded by the passing official
run. The shell build used the public key from the unauthenticated sign-in page;
no customer cookies were used. Upload credentials were disabled, and no deploy
or source-map upload occurred.

## Hosted documentation and tracking

The existing automatic docs preview was verified READY through the connected
Vercel app at `0a005b282c02cd1e4c6feedd0b7eb9370a9df224`:
https://matrix-os-www-git-codex-eng-418-collaboration-pr-0582af-finnaai.vercel.app/docs/developer/collaboration-preview-pairs

Document scrollWidth equals clientWidth at all three widths. Screenshots and
WebM recordings are outside Git at `/tmp/eng418-site-preview-evidence/`.
Optional cookies were rejected and third-party browser requests were blocked.
No deployment, protection change or temporary share link was created. This is
hosted documentation evidence, not authentication or collaboration acceptance.
Local cold-compiler timeouts are superseded for responsive validation by this
hosted result. The broad docs run initially passed 132/133; the corrected
metadata case and hosted test check subsequently passed.

ENG-418 was verified and updated through the connected Linear application. It
remains in Engineering, assigned to requester Nima and In Progress, with the
spec, native stack, launcher, qualification and public docs PRs linked. The raw
Symphony-only GraphQL client is unavailable in this host; no custom credential
path was introduced.

## Remaining gates

- T029: live Web Desktop and Electron Desktop screenshots/recordings for equivalent
  collaboration journeys, uploaded outside Git with exact-build provenance.
- T040: current-head Greptile review, any resulting fixes, applicable CI and
  evidence handoff to Slack #tech. External review/Slack posts await authorization.
- T041: protected real-Clerk/two-VPS/model acceptance, outsider denial,
  restart/failure recovery and exact-resource cleanup; native macOS validation.

No merge, deployment, paid cloud activation or customer permission change has
occurred. Recommend collaboration/platform, Electron/UI and developer-docs owner
review. No fixture or ready infrastructure report establishes live acceptance.

## CI repair — 2026-11-03

The nine failing stack layers exposed test setup defects, rather than a new
diagnosis of the original customer sharing failure:

- Startup wiring still searched for an inline `db.destroy()` after primary-pool
  ownership moved to `closePrimaryDb()`. The corrected test verifies the helper
  closes that pool and that managed-feature workers drain before it is called.
  The original assertion failed locally; all three wiring checks now pass.
- Bundle-boundary and launch-route suites unconditionally opened real Postgres
  in ordinary unit shards without `MATRIX_TEST_POSTGRES_URL`. They now follow the
  other real-server suites' unit-lane guard. Both remain in the required
  collector, which rejects missing URLs and skipped assertions. Disposable
  Postgres qualification passed 41 bundle/release and 15 launch/proof assertions,
  with zero skips. Their unit/collector checks passed 27 and 36 assertions.
- Three real child-process fixtures hardcoded `/usr/bin/node`; CI reported
  `ENOENT` or startup failure. They now use the Node selected in the runner's
  `PATH`, preserving real startup, cancellation and owned-child cleanup checks.
- The legacy update UI's catch-all IPC mock returned invalid preview metadata.
  Its normal-app `app:get-preview` response is now explicitly `null`. Both
  original UI failures were reproduced before correcting the fixture.
- General E2E collected the native pair journey without an Electron production
  build. A required Electron-lane step now runs it after that build under Xvfb
  and retains fixture captures as an Actions artifact. General E2E excludes this
  journey; explicit required execution still fails if its build is missing.

The six focused Electron suites passed 11 assertions; four workflow/collector
suites passed 92. All eight typechecks passed. Pattern checks reported zero
violations and five inherited warnings; the changed-scope React audit reported
zero errors or warnings. Native fixture execution requires
`MATRIX_DESKTOP_E2E_REQUIRED=1` after `bun run build:desktop`.

Fixes stay in their owning layers and propagate through ordinary parent merges,
preserving published ancestry. No rebase or update from main was performed.
Remote current-head review and full CI must pass before this repair is declared
complete. T029/T041 live acceptance remains separate; no Slack post, cloud
activation, customer modification, merge or deployment is part of this repair.

## Native stack recreation and hosted follow-up — 2026-11-03

The requester approved metadata-only recreation of native stack #3026 as
[#3112](https://github.com/HamedMP/matrix-os/stack/3112). All 26 PR numbers and
published source heads were verified unchanged; only launcher's parent changes
to helper #3107, reducing its diff from 60 to 49 files. Every PR still links
ENG-418. No rebase, main update, branch deletion or PR closure occurred.

Hosted native run `41643675599` failed in the secondary Electron launch after
the initial Owner/Member sessions opened. The wrapper omitted Playwright's
Linux test-only sandbox flag. Denying user namespaces in the native test's
process tree reproduced the exact startup error; applying the same fixture
policy to the wrapper passed the full journey **1/1**, zero skips. Four focused
process/environment/readiness/cancellation/artifact suites passed **13/13**.
Production launch flags and authorization remain unchanged.

The separate revocation job `125943366778` failed on an authenticated GitHub
`GET /repos/HamedMP/matrix-os/pulls/3096` with HTTP 503. That is an API failure,
not a candidate assertion; source gates remain fail-closed. New-head CI must
qualify the published fix. Live Clerk/two-VPS/model acceptance stays pending.
