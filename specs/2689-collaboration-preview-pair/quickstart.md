# Collaboration preview pair: implementation and qualification guide

Tracking: ENG-418. Status: proposed interface; implementation/activation is not
claimed by this planning document. Spec PR #3022 is the bottom native stack layer.

## Prerequisites

- A same-repository open candidate PR, normal authorized maintainer and exact SHA.
- Reviewed trusted Preview controller and configured two-account fixture set in an
  approved isolated Preview identity/service/signing/data boundary; a third real
  outsider account has no test-org membership. Never use customer account copies.
- Existing bounded Preview inference allowance enabled and unexpired for the exact
  machines; report its expiry separately from the72h pair lifetime.
- Matching existing desktop artifact for the actual local OS/architecture, normal
  GitHub/Matrix authentication and a local desktop session for Electron.

No prerequisites are satisfied merely because their code or secret names exist.
The unfinished spec530 wildcard route stays off. Provisioning and production
activation require the reviewed workflow's normal operator/environment gates.

## Developer sequence

1. Use the existing implementation worktree on `codex/eng-418-preview-pair-foundation`.
   Run `bash .specify/scripts/bash/check-prerequisites.sh --json --paths-only` to
   confirm the spec pointer; helper regressions use real Git/Bash fixtures.
2. Read research, data model and contracts. Generate dependency-ordered tasks,
   verify the16-item requirements checklist, then implement with tests first.
3. Commit each complete phase to its native layer and publish through `gh stack
   submit --auto`. Every PR includes ENG-418, stack/spec and truthful validation.
4. The proposed `preview-collaboration-pair` request produces one canonical pair
   report/manifest. Confirm both real owners/members, exact running candidate,
   fresh control registrations, source-pinned platform and supported desktop bytes.
5. On the local machine, run the proposed `bun run preview:pair:open -- --pair <id>
   --profile <trusted-control-profile>`. This command is available only after the
   launcher layer ships; do not represent these proposed commands as working today.
6. Sign in normally as the expected owner and member, using separate browser
   sessions if needed. Verify visible role/computer/organization/source in each
   app. A wrong account must fail closed; do not force headers or inject sessions.

## Required acceptance

| Case | Starting point | Pass evidence |
| --- | --- | --- |
| Local isolation | Two preview apps plus normal app | Distinct actual actors/profile cookies/runtime selection; sign-out/relaunch leaves other sessions unchanged |
| Share during creation | New private scratch project A | Creation opt-in observed; dialog/publication/indicator results recorded; failure remains private |
| First later Share | Different new private project B | Dialog opens on first attempt; no retry or preaccepted grant; explicit publish |
| Member journey | Pending member invitation | Shared with me → actual acceptance → inherited Chat prompt → actual persisted response on reopen |
| Outsider | Third authenticated account outside org | Discovery/link/prompt denied; no owner-side execution |
| Recovery | Active project and owner restart | Fresh control reconnect, member reopen, no duplicated/widened access |
| Failed publication/revocation | Injected bounded failure or explicit test grant revoke | No partial publication; revoked caller denied through real current authorization |
| Cleanup | Stop, close, request removal or expiry | Access retired; both exact provider servers absent; fixture/capacity released only after proof |

Capture Electron Desktop and Web Desktop separately, with exact artifact/source,
run/generation, real versus simulated boundaries and any not-run case. Attach or
link screenshots and recordings in PR evidence; keep them out of the repository.
Use the approved review-channel workflow for the applicable Slack permalink.

## Diagnosis and updates

An environment-ready pair is not a collaboration pass. Inspect the failed stage,
actual owner-session/preflight/inventory/publication results and scoped logs. Do
not initialize customer Git, change org policy, inject a grant or widen permissions
to turn a red candidate green. Preserve the reproduction while its hard expiry
allows it. A new PR push only marks currency outdated; explicit update is a clean
reset/new generation in V1 and requires both computers and desktop source to agree.

## Cleanup and limitations

Closing apps stops only owned local children. Stop the cloud pair explicitly or
let close/expiry trigger its durable cleanup. Do not delete baseline fixture
accounts/orgs, other test runs, customer Shared with me entries or personal profiles.
Provider uncertainty stays cleanup-pending and retains capacity. Windows/macOS
native behavior requires actual target qualification; Linux/Xvfb alone does not
qualify native keychain/protocol behavior on another OS.

Public docs deliverable: separate `FinnaAI/matrix-os-site` PR under `content/docs/`
for request, exact builds, dual-app login, update/reset, readiness, evidence and
cleanup. No private actor IDs, credentials, customer hosts or operator shortcuts.
