# Electron Desktop account entry

The signed-out app presents **Welcome to Matrix OS**, with **Create account**
and **Sign in** as separate account intents. Product copy uses Matrix OS and
plain browser instructions. Runtime/framework names, infrastructure details,
and trial/billing claims do not belong on this entry screen; the browser setup
flow remains authoritative for eligibility, pricing, and computer selection.

The welcome scene reuses the bundled `matrix-dusk.webp` wallpaper and canonical
rabbit mark. Colors and font families come from `@matrix-os/brand`; the account
entry palette stays fixed across workspace themes. Headings use Bricolage
Grotesque and controls/body copy use Geist. Compact windows stack the scene and
account panel, with scrolling so approval actions remain reachable. Controls
provide a visible focus ring and respect reduced motion.
The artwork starts below the shared native titlebar height, leaving the window
controls on a fixed paper-colored drag region at every window width.

## Browser handoff

Both actions use the existing typed device-auth bridge. Creating an account
sends `intent: "sign-up"`; signing in sends `intent: "sign-in"`. The trusted
main process owns the verification URL, polling, credentials, and signed native
return. The renderer keeps only the temporary approval code, URL, and UI phase.
The return link focuses the app; authorization still completes through polling.

While starting, both account actions are disabled and the selected action shows
**Opening browser…**. The approval screen shows the code, a browser reopen
action, and waiting status. Failed browser launches keep the code and a
selectable verification URL available; operating-system errors are logged as
sanitized diagnostics. Expiry or polling failure restores the account actions
with a safe alert. Authorized polling stops before refreshing connection state.
If the refresh resolves without a signed-in connection or rejects, the account
actions return with a safe retry alert instead of remaining on the waiting screen.

This is a presentation refresh of the existing native browser handoff, rather
than a new authentication method. Web Canvas and Web Desktop already run in
the authenticated browser; their account routing and hosted setup are unchanged.

## Validation

- `tests/desktop/signin-device-auth.test.tsx` covers account intent, busy state,
  browser failures, expiry, polling errors, authorized refresh, and recovery
  when an approved connection cannot refresh.
- The existing brand-panel tests protect the shared mark used by other surfaces.
- `tests/e2e/desktop/signin-brand.e2e.test.ts` launches the built app with a
  temporary profile and isolated device-auth handlers. It verifies bundled
  assets/fonts, both account intents, browser reopen, and compact-window
  scrolling. Evidence goes to `output/playwright/signin-brand/`.

Run the desktop build before the end-to-end suite. Use
`MATRIX_DESKTOP_E2E_REQUIRED=1` to fail when that build is missing. These fixtures
never create a hosted account or approve a real connection.

## Native credential isolation during development QA

An independent `OPERATOR_USER_DATA_DIR` separates local files, but does not by
itself separate the macOS Keychain service used by Electron Safe Storage. A
locally signed test app using the product name can prompt for the existing
`Matrix OS Safe Storage` item. Do not approve that prompt, copy credentials,
change Keychain access lists, or disable native encryption to continue a test.

For an **unpackaged development build**, explicitly set
`MATRIX_DESKTOP_QA_IDENTITY=isolated` together with an existing absolute QA
profile directory in `OPERATOR_USER_DATA_DIR`. Startup derives a stable
`Matrix OS QA <digest>` app name from that directory's canonical path before
Electron readiness. Packaged builds, unknown QA values, missing directories,
and profiles overlapping the production directory are rejected. The normal
product name and existing profile behavior stay unchanged without the flag.

Use a new empty QA profile for its first login and retain the same path for
restarts. The QA build uses real OS encryption in its own namespace. It does
not migrate an account or its permissions: authenticate normally, select the
intended test Computer before approval, and handle a device conflict through
the existing explicit owner flow. An unexpected OS access prompt remains a
reason to stop; this configuration cannot guarantee that macOS never prompts.
