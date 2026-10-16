# Legacy funded host recovery

Ticket: [ENG-205](https://linear.app/matrix-os/issue/ENG-205). Status: implementation; no live acceptance implied.

## Goal and scope

Make reviewed host funding reconciliation executable for eligible existing customer primaries with missing managed configuration. Preserve current owner policy, credit, runtime epoch, explicit account/harness/model choices and all owner data. Current-source host inspection found an archive-validator installation failure and legacy hosts without the scoped Sync credential required by the strict epoch endpoint. Fix each independent prerequisite; do not weaken endpoint authentication or claim installation proves readiness.

## Authority and flow

Existing operator authority selects the actual running authorized customer primary, exact owner/handle/machine/current database epoch and verified recipient. Add a distinct prepare-only encrypted Sync initialization envelope to the existing operator credential tool. It contains only the missing Sync token, exact source/version and host-file fingerprint, recipient binding, nonce and at most30s lifetime. It never activates or changes a database epoch and never includes funded/speech credentials.

A reviewed protected host initialization mode requires genuinely absent Sync assignment (not malformed, quoted, duplicate or conflicting), protected input/key/ancestors, exact identity/release/CAS, matching local epoch when present and exclusive shared writer lock. Authenticate the temporary token with the unchanged strict funded-host-epoch endpoint over its fixed TLS origin and validate owner/machine/primary/source/current epoch/freshness/cohort/eligibility/financial admission. Insert only the scoped Sync assignment, with a bounded exclusive root-only before/after journal and fsync/CAS. Preserve unknown commit evidence and reject replay/conflicting credentials. No services restart or epoch/funding fields are added by initialization. Then existing608 performs its own atomic epoch-plus-funding reconciliation and restoration.

The archive installer must accept the exact valid canonical bundle while retaining bounded expansion/member counts, protected-namespace exactness, no extraction of unrelated members, duplicate/unsafe protected-entry rejection, checksum/source verification and temporary cleanup. Diagnose the failed predicate before changing limits or validation.

## Auth matrix

| Resource | Authority | Public |
| --- | --- | --- |
| Operator initialization preparation | Protected operator DB/platform-secret inputs; explicit current owner/machine/primary/authorized customer and recipient/fingerprint binding; read-only DB | No |
| Protected initialization | Reviewed protected bytes, root-private encrypted input/key, shared anchored writer lock and current strict endpoint receipt | No |
| Existing epoch/config endpoints | Current machine-scoped Sync HMAC, current DB epoch, exact bounded source/cohort/expiry/policy/deletion/liability admission; unchanged | No |

No legacy handle bearer fallback, token/epoch guessing, other-owner credential copying, registration reset, new IAM, credit grant/reset, model activation or route switch. Encryption protects confidentiality; operator authorization and root-only verified delivery establish sender authority.

## Implementation units

- U1 archive compatibility (root): `distro/customer-vps/funded-host-config/install.py`, focused installer regressions. Test-first; preserve all existing trust boundaries and validate the actual failed archive predicate.
- U2 scoped Sync initialization (worker): `scripts/ops/rotate-runtime-tokens.ts`, a focused initialization envelope/preparation module, a focused protected initialization module, existing host entrypoint/generator wiring and focused operator/protected-file tests. Test-first, no local test/build/dependency install; root owns CI/publication. Keep existing rotation and608 auth unchanged. Shared repair primitives are the only environment writer.
- U3 release/acceptance (root): exact reviewed source delivery, bounded scoped canary gate, own proof initialization, protected maintenance and settled request; then per-host fresh preflight/outcomes and bounded serial expansion. Busy/unknown/ineligible/intentional opt-outs remain explicit retry/review outcomes; do not claim fleet completion from metadata.

## Verification

GitHub CI only: current/later epochs unchanged; no DB writes in initialization; strict envelope/recipient/freshness/nonce/schema and secret-output checks; genuine absence versus duplicate/malformed/present credential; endpoint denial/deletion/policy/liability/source/rotation races leave baseline unchanged; no-follow ancestors/key/input/shared-lock/CAS/inode races; complete atomic before/after images and exclusive journal/crash/replay/rollback conflicts; generated composition and unchanged existing rotation/epoch authentication. Installer reproducer covers the observed valid archive and unsafe/duplicate protected members, bounds and cleanup.

Operational acceptance: independent receipt/source/hash and loaded identity/configuration, restored service state, fresh canonical credit, one real funded request and exact ledger settlement. Preserve private operator evidence and rollback records. No unattended promise of uninterrupted arbitrary newly admitted Chat/Bot/cron work; use a coordinated bounded maintenance window and defer active work. Existing source lacks a global admission-first quiet fence.

No UI changes. Product behavior and recovery boundaries need a short public-safe update in the separate `FinnaAI/matrix-os-site/content/docs` repository. Recommend engineering/security review of this operator authentication boundary. No customer identifiers or operator secrets belong in this repository.
