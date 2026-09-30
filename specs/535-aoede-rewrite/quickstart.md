# Aoede local validation

Do not start the full runtime or invoke paid providers without separate authorization. Do not source .env or expose credentials. Standalone Aoede is not attached to visible Chat.

## Deterministic development

Use the existing bun/pnpm scripts after verifying their actual composition. Before running any composed fixture, assert that BOTH speech and canonical model/action adapters are fake. `MATRIX_VOICE_SIMULATOR=1` alone is not a no-paid-call guarantee, grants no native action eligibility, and currently selects an empty/discarding simulator even before the production guard. Until fixed, `dev:voice:integration` means simulator composition, not real managed-speech integration.

Presentation fixture scenarios: idle/permission, listening, batch-final caption, thinking, tool/activity, speaking, approval, qualified clarification, navigation/artifact/reconciliation result, reconnect and failure. Replace or explicitly label the existing Chat-attached `tests/fixtures/voice-session/ui-fixture` as legacy; it is not Aoede evidence. Run `AoedePanel`/controller through standalone Web Canvas and Web Desktop fixture hosts with Chat closed. Record actual commands and inspected artifact paths in requirement-evidence.md; browser fixtures are not real-device evidence.

## Focused verification

Use `pnpm exec vitest run` with exact affected files, plus affected-package `tsc --noEmit`. Run failures first for risky changes. The final deterministic gate is: focused affected tests; composed fake-speech + fake-model/action test; disposable-Postgres delivery and action suites; `bun run typecheck`; `bun run check:patterns`; `git diff --check`; `npx react-doctor@latest packages/ui --verbose --scope changed`; `npx react-doctor@latest shell --verbose --scope changed`; `bun run build:shell:production`; and inspected standalone Web Canvas/Web Desktop screenshots plus keyboard/focus/accessibility states. Record failures and environment blocks rather than suppressing them.

## PostgreSQL

`bun run test:voice:postgres` must provision a disposable local isolated database or fail clearly. Do not point it at a shared database, read credentials from `.env`, or claim PGlite proves crash/locking behavior. Cleanup only test databases created by the gate. The command currently omits `tests/gateway/chat-action-postgres.test.ts`; add it to this gate (or add a separately mandatory action-PG command) before relying on the script. The old raw-array JSONB fixture defect is fixed in source but requires a current rerun.

## Optional qualification, not authorized now

Provider conformance may clearly skip absent explicit credentials/authorization. Real managed STT → actual Codex → managed TTS, mic/speaker, production parity creation/update/restart, account retention/funding, measured latency/interruption and usability are separate gates. Packaged-Electron qualification is deferred to the Electron follow-up, not this delivery. Preview-no-charge bypasses Matrix ledger debit, not upstream provider billing.

## Delivery

Local Conventional Commits only, scoped staging after full diff review. No push/PR/merge/deploy/shared infrastructure changes. Evidence distinguishes A implemented, B deterministically validated and C product-qualified. Public site documentation/release PR requires separate authorization.
