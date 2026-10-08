# Aoede local validation

Do not start the full runtime or invoke paid providers without separate authorization. Do not source .env or expose credentials. Standalone Aoede is not attached to visible Chat.

## Deterministic development

Use the existing bun/pnpm scripts after verifying their actual composition. Before running any composed fixture, assert that BOTH speech and canonical model/action adapters are fake. `MATRIX_VOICE_SIMULATOR=1` alone is not a no-paid-call guarantee, grants no native action eligibility, and selects an empty/discarding simulator; the production guard now denies the flag outright. `dev:voice:simulator` means simulator composition, not real managed-speech integration.

Run `pnpm exec tsx scripts/aoede-fixture-screenshots.ts` for idle/permission, listening, batch-final caption, thinking, tool/activity, speaking, approval, qualified clarification, navigation/artifact/reconciliation, reconnect and failure states. The fixture mounts the real `ShellAoedeHost` on mocked Canvas/Desktop stages with Chat closed and explicitly injected fake fetcher/media. Its machine-readable gate requires both fake seams and zero schema issues. Captures/status live under `.amp/in/artifacts/aoede/`; old `tests/fixtures/aoede/screenshots/` captures are not current evidence. The older Chat-attached fixture is labeled legacy. These images are isolated-host evidence, not full-shell or real-device qualification.

## Focused verification

Use `pnpm exec vitest run` with exact affected files, plus affected-package `tsc --noEmit`. Run failures first for risky changes. The final deterministic gate is: focused affected tests; composed fake-speech + fake-model/action test; disposable-Postgres delivery and action suites; `bun run typecheck`; `bun run check:patterns`; `git diff --check`; `npx react-doctor@latest packages/ui --verbose --scope changed`; `npx react-doctor@latest shell --verbose --scope changed`; `bun run build:shell:production`; and inspected standalone Web Canvas/Web Desktop screenshots plus keyboard/focus/accessibility states. Record failures and environment blocks rather than suppressing them.

## PostgreSQL

`bun run test:voice:postgres` provisions a disposable local isolated database or fails clearly. Set `MATRIX_VOICE_POSTGRES_ADMIN_URL` explicitly to a disposable-test-capable local server; never source shared credentials from `.env`. The script creates/drops only its random `matrix_voice_test_*` database. The gate includes action concurrency/SIGKILL recovery and canonical voice delivery; the current 22-file / 341-pass result is recorded in `requirement-evidence.md`. PGlite is not proof of process crash or native PostgreSQL locking.

## Optional qualification, not authorized now

Provider conformance may clearly skip absent explicit credentials/authorization. Real managed STT → actual Codex → managed TTS, mic/speaker, production parity creation/update/restart, account retention/funding, measured latency/interruption and usability are separate gates. Packaged-Electron qualification is deferred to the Electron follow-up, not this delivery. Preview-no-charge bypasses Matrix ledger debit, not upstream provider billing.

## Delivery

Local Conventional Commits only, scoped staging after full diff review. No push/PR/merge/deploy/shared infrastructure changes. Evidence distinguishes A implemented, B deterministically validated and C product-qualified. Public site documentation/release PR requires separate authorization.
