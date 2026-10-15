# Funded host epoch bootstrap

Ticket: ENG-205. Status: implementation/review; no production acceptance implied.

## Goal

Repair missing local runtime-epoch metadata on eligible customer primaries without guessing epoch 1, rotating credentials, changing policy/credit, or copying another machine's credential. Keep GLM Flash and existing owner settings unchanged outside the managed repair fields.

## Files and approach

- `packages/platform/src/funded-host-config.ts`: metadata-only epoch endpoint sharing existing cohort and financial admission.
- `distro/customer-vps/funded-host-config/epoch.py`: focused protected missing-epoch application/journal/rollback; self-contained build concatenation in `scripts/prepare-funded-host-component.mjs`.
- `reconcile.py` / `recovery.py`: read-only admission with authoritative epoch, maintenance wiring, exact complete-image restoration.
- Focused Platform, protected-host and generated-component regressions.

When local epoch is absent, obtain an expiring metadata receipt using the installed current machine-scoped Sync credential. Verify owner/machine/handle/primary and exact source; then request normal funded configuration with that epoch. Only explicit coordinated maintenance may mutate. Atomically publish one complete image containing the absent epoch plus the four normal funding fields, retaining the original epoch-absent image in a separate versioned root-only journal. No intermediate epoch-only image becomes visible. Existing present epochs continue through the unchanged four-field repair; malformed or mismatching metadata defers.

## Auth matrix

| Resource | Auth and admission | Public |
| --- | --- | --- |
| GET `/internal/containers/:handle/funded-host-epoch` | Current DB epoch's machine-scoped Sync HMAC; strict UUID/primary headers; no epoch header, query or body; same enabled bounded cohort, expiry/source, running authorized customer, policy, deletion and financial checks as funded config | No |
| Existing funded-host-config GET | Existing epoch-bound machine Sync credential and all existing gates | No |
| Protected maintenance | Existing one-use explicit-update receipt, exact verified bundle/component, coordinated idle/writer window, stopped runtime services and fresh remote admission | No |

Metadata returns only version/kind/source/sourceSha/issuedAt/expiresAt and identity including owner/current epoch; no credential/config/model/budget. Private/no-store. At most 30 seconds and bounded by policy/cohort expiry. No legacy handle credential fallback; stale epoch credential cannot bootstrap itself after rotation. External calls keep existing fixed HTTPS origin, certificate verification, redirect rejection, body/deadline limits; DB uses read-only repeatable snapshot and 5-second statement timeout.

## Atomicity, rollback and recovery

Protected helper holds the existing exclusive environment writer lock, anchored no-follow descriptors, literal identity checks and full-file hash/inode/device CAS. Missing-epoch journal is exclusive root-only, bounded, fsynced and never silently replaced. Final image contains only five managed changes; unrelated assignments and owner home remain untouched. Original and complete post-image are the only restart-authorized images. An unknown commit retains journal and fails closed. Rollback validates exact identity, inserted epoch, protected journal and affected fields; refuses later token/epoch changes, preserving unrelated edits. Existing applied state owns rollback authority until resolved. Startup/passive paths cannot apply or restart.

## Tests before implementation

- Valid current scoped Sync token with absent epoch header returns exact metadata only; epoch2 cannot use stale epoch1/legacy/other-machine/slot credentials.
- Every existing cohort, deletion, policy and pending/corrupt obligation gate applies to both endpoints; expired/source-mismatching responses fail closed; no financial writes.
- Real temporary protected files: absent epoch atomic complete image, present same no-op path, duplicate/malformed/present-different epoch denied, CAS/ancestor/writer races, exclusive journal, crash before/after rename, rollback conflicts/unrelated edits, no secret output.
- Generated installer/maintenance/restoration/recovery chain handles original epoch-absent image and complete post-image; no epoch-only intermediate; startup/passive never writes. Existing epoch-present suite remains green.

## Rollout and documentation

Require exact-source disposable VPS + Electron Desktop evidence, then fresh bounded owner-safe fleet inventory; DB status and old task lists do not prove online/idle. Cohorts retain existing <=100 UUID and <=7-day limits; defer busy/unknown/untrusted/custom/disabled/ineligible hosts, keep journals and report reasons. No credit, IAM, probe-budget or route shortcuts. Include separate public product-behavior documentation PR in `FinnaAI/matrix-os-site/content/docs/`; keep recipient details and operator commands private.

### Review regressions and fixture scope

Rollback uses protected attempt identity and local before-image proof; it must not
need Platform to clean an unchanged failed bootstrap. Both apply and rollback
must enforce the 64 KiB final environment bound before publication. The emitted
program suite runs both epoch-present and epoch-absent complete lifecycles,
including outage before publication, unavailable inspection after publication,
resume, rollback and later updater recovery. The large existing serial fixture
remains the shared emitted-program harness; missing-epoch entry coverage lives
in a focused separate suite. Future scenario growth should extract archive and
updater-recovery phases from that harness instead of duplicating it.
