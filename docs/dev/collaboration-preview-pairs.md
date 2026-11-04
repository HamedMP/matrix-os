# Collaboration preview pairs

An ENG-418 preview pair runs one unmerged PR on two disposable, test-owned VPSes
in a dedicated test organization. Matching Owner and Member Electron apps use
separate profiles. Your normal Matrix computer/profile stays separate.

The feature is default-off. These commands require reviewed protected setup:
a dedicated test identity issuer/organization/actors, isolated platform data,
reviewed controller commit, provider scope and bounded funding. A branch containing
this implementation is not evidence that the setup or live acceptance exists.

## Request and open

Use your normal first-party Matrix CLI profile and GitHub login. Credentials are
read in memory; never paste operator secrets into an app or manifest.

```bash
bun run preview:pair:create -- --pr <number> --profile <control-profile>
bun run preview:pair:report -- --pair <uuid> --profile <control-profile>
bun run preview:pair:open -- --pair <uuid> --profile <control-profile>
```

Create prints the recorded workflow/report identity. Wait for the canonical report
to be ready before opening. The launcher independently checks the reviewed run,
source receipt and artifact bytes. It supports the built Linux x64 and macOS
arm64/x64 targets; other targets fail. There is no installed-app fallback.
The candidate PR must contain the preview-client foundation. Local execution of
unmerged code is not an operating-system sandbox: review the candidate first.
Normal macOS unsigned-app protections still apply; this flow never bypasses them.

The open command remains running while its newly opened apps run, so their app
resources remain available. Sign in normally with the Owner and Member test
accounts shown in their banners, selecting the corresponding preview computer.
Wrong accounts/slots are refused. The current dedicated organization is selected
through the existing membership/store flow. A repeated open focuses/reuses an
existing matching role; it cannot kill that process when the new command exits.

Close both apps or interrupt the command to stop only the newly spawned apps.
This does not stop the cloud pair. Profiles preserve UI state between opens and
remain separate by pair, generation and role. Candidate apps neither update
through ordinary OTA nor claim the normal app's auth callback.

## Test and diagnose

Test fresh project creation with sharing enabled, then a separate new project's
first later Share. Record the actual dialog, explicit publication, member's
Shared with me activation, inherited Chat prompt and persisted response on reopen.
Test outsider denial, owner restart and a failed publication staying private.
A ready environment is not a passing collaboration test. Do not initialize a
customer Git checkout, inject sessions/grants or weaken authorization to pass it.

Keep the pair report and exact source/build/run IDs with each result. Capture
Web Desktop and Electron Desktop separately. Keep recordings/screenshots outside
Git and attach them through the authorized review/evidence workflow. Never put
credentials, private content or customer identifiers in public reports.

## Update and retire

```bash
bun run preview:pair:update -- --pair <uuid> --profile <control-profile>
bun run preview:pair:stop -- --pair <uuid> --profile <control-profile>
bun run preview:pair:open -- --pair <uuid> --cleanup --generation <n> --role owner
```

A push marks source currency outdated; explicit update performs a clean new
generation. Close older role apps first. Epoch changes can require closing an
old process before reopening. Stop and expiry retire access and run exact provider
cleanup; uncertainty retains the fixture lease/capacity. Before admission, cancel
the recorded workflow rather than issuing a pair stop.

Local cleanup removes only the explicitly selected inactive role profile. Live,
unknown or reused process IDs block it. Ordinary stale activity records recover
only after their process is proven absent; an interrupted recovery guard requires
manual inspection. Never remove a guard or profile while an app might be running.
Provider cleanup never deletes baseline test actors/organizations or customer data.

See the [spec and qualification](../../specs/2689-collaboration-preview-pair/quickstart.md)
for setup gates, scope, fixture limitations and required live acceptance.

## Qualification exports

Run `bun run preview:pair:qualify -- --pair <uuid> --results <new-private-file>
--output <new-private-report> --profile <control-profile>` from a terminal after
opening a healthy pair. Choose files in a private directory outside Git. The
command creates a16-case template (eight journeys on two surfaces) and waits
while you perform the normal-account UI actions. Edit observed steps/captures,
leave missing cases `not_run`, then continue to export. Both screenshot and
recording links are required for a claimed live pass; use clean HTTPS links
without credentials, signed query or fragments. Every result remains unreviewed.
The command reads Source only and never shares a project or changes cloud state.

For deterministic first-party fixture coverage, use
`bun run preview:pair:qualify:fixtures -- --expected-sha <full-clean-head>
--output <new-private-report>` with `MATRIX_TEST_POSTGRES_URL` explicitly pointing
to your disposable loopback database. Install the frozen lockfile and build normal
workspace prerequisites first. All eight selected suites must execute assertions,
without skips. The resulting receipt always says `fixture` and live product
acceptance stays `not_run`; no fixture can satisfy the protected acceptance gate.
