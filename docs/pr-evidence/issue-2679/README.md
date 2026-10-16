# Shared project deletion verification

Electron Desktop screenshots were captured from the built app under Xvfb using
`tests/e2e/desktop/project-deletion.e2e.test.ts` and the local synthetic gateway.
The flow opens the project actions menu by keyboard, requires the exact project
name, deletes it, and checks that the renderer emits the collaboration discovery
refresh only after success.

- `electron-delete-confirmation.png`: exact-name confirmation in Electron Desktop.
- `electron-project-deleted.png`: the project disappears after successful deletion.

These screenshots verify the renderer flow against a fixture API. Shared-project
authorization, the real gateway composition, shared Chat/terminal cleanup (including
an active run with an internal collaboration binding), failure/retry,
recovery, runtime authority, and external-folder preservation are exercised by
`tests/gateway/shared-project-deletion.test.ts` with PostgreSQL-compatible fixtures
and temporary project homes. No customer computer or customer data was used.
