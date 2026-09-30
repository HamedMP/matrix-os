# Aoede local validation

Do not start the full runtime or invoke paid providers without separate authorization. Do not source .env or expose credentials. Standalone Aoede is not attached to visible Chat.

## Deterministic development

Use the existing bun/pnpm scripts after verifying their actual composition. Before running any composed fixture, assert that BOTH speech and canonical model/action adapters are fake. MATRIX_VOICE_SIMULATOR=1 alone is not a no-paid-call guarantee and grants no native action eligibility.

Presentation fixture scenarios: idle/permission, listening, thinking, tool/task, speaking, approval, clarification, progress/result, reconnect, failure. Run shared presentation through Web Canvas, Web Desktop and Electron fixture hosts with Chat closed. Record actual commands and artifact paths in requirement-evidence.md; do not treat this fixture as packaged-Electron or real-device evidence.

## Focused verification

Use pnpm exec vitest run with exact affected files, plus affected package tsc --noEmit. Run failures first for risky changes. Run bun run check:patterns and git diff --check after integration. React changes additionally require React Doctor against package roots; shell changes require bun run build:shell:production. Never use npm for installs/scripts or fetch a floating brand-new audit dependency merely to pass a gate.

## PostgreSQL

bun run test:voice:postgres must provision a disposable local isolated database or fail clearly. Do not point it at a shared database, read credentials from .env, or claim PGlite proves crash/locking behavior. Cleanup only test databases created by the gate. Include canonical action concurrency/recovery cases in addition to delivery races.

## Optional qualification, not authorized now

Provider conformance may clearly skip absent explicit credentials/authorization. Real managed STT → actual Codex → managed TTS, mic/speaker, packaged Electron, production parity creation/update/restart, account retention/funding, measured latency/interruption and usability are separate gates. Preview-no-charge bypasses Matrix ledger debit, not upstream provider billing.

## Delivery

Local Conventional Commits only, scoped staging after full diff review. No push/PR/merge/deploy/shared infrastructure changes. Evidence distinguishes A implemented, B deterministically validated and C product-qualified. Public site documentation/release PR requires separate authorization.
