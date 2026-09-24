# Electron Desktop browser sign-in import

## Goal

Transfer selected website passwords and cookies from local Chromium-family browser profiles into Matrix Browser, and selected Login items directly from the local 1Password app through its CLI. A user can then fill an imported password into the current website's login form. The existing saved-page import remains available.

## Ownership and source of truth

- Source browser databases and the 1Password vault are read only. Matrix never modifies them.
- Matrix Browser cookies live in an Electron session partition derived from the signed-in Matrix user ID. That partition is separate from other accounts, the hosted shell, and app partitions.
- Imported passwords live in an account-specific `browser-passwords.bin` under Electron `userData`, encrypted through Electron `safeStorage`. No plaintext password file, renderer local storage, gateway upload, or Matrix account sync is involved.
- The user can reimport to update an existing origin and username, remove an individual imported password, or export a readable JSON copy to a chosen file. Local browser profile files remain user controlled.

## Flow

1. Electron Desktop discovers known local browser profiles under the current user's macOS Application Support directory. Only source names and profile names cross IPC.
2. Selecting a profile reads URL and cookie-domain metadata and shows counts per website. The user selects sites. Secret values are not previewed.
3. On import, the main process requests the source browser's Safe Storage value from macOS Keychain only if selected rows contain encrypted values. The system may prompt for access. The main process decrypts supported Chromium `v10` entries in memory, checks current cookie domain digests, validates each entry, writes passwords into the encrypted local vault, and sets cookies through Electron's browser session API. Expired, partitioned, invalid, or unsupported entries are skipped and counted.
4. The 1Password picker invokes the local `op` CLI using desktop app integration. It lists Login metadata, then fetches secret fields only for selected item IDs. Only website, username, and password are imported; OTP fields, passkeys, other categories, and attachments are excluded.
   Completed 20-item batches are persisted as the import runs; if a later item fails or the overall deadline arrives, completed items remain and the rest are counted as skipped.
5. While visiting a site, Passwords lists usernames only. A chosen password is filled from the main process into an active Browser view after both main and page context verify the current origin. Password values never cross renderer IPC.
6. A user can remove one imported password, or explicitly export the encrypted vault contents to a new, owner-only JSON file through a native save dialog. The renderer receives only success or failure.

Signed-in session transfer is best effort: cookies alone do not restore sites that bind sessions to a device or require local storage, IndexedDB, passkeys, a fresh token, or reauthentication. Session-only cookies retain session-only behavior; persistent cookies retain their expiry. Import never promises a site remains signed in.

The earlier unscoped `persist:browser` partition has no recorded Matrix account owner. To avoid assigning one account's website session to another, this release does not migrate those older cookies into an account partition. Existing Matrix Browser sites may require sign-in once after the change. The legacy partition remains on disk for local owner recovery rather than being silently erased.

## Surface scope

Electron Desktop is the native local-import surface. Web Desktop and Web Canvas cannot access other browsers' local databases or macOS Keychain from the browser sandbox. Web Mobile and Native Mobile do not expose Matrix Browser's native Electron partition. The existing saved-page feature remains distinct from this platform-limited credential flow.

## Auth and trust boundaries

| Boundary | Authorization | Validation |
| --- | --- | --- |
| Renderer → `browser:list-secret-sources` / `browser:preview-sites` | Main-process IPC from the trusted Electron renderer | Fixed source IDs; known local directories; symlink and size checks; metadata only |
| Renderer → `browser:import-sites` | Explicit profile and website selection | Source ID and host schemas; bounded counts; no arbitrary file path or raw SQL |
| Renderer → `browser:list-1password` / `browser:import-1password` | Explicit user action; local 1Password app unlock and CLI integration | Bounded item IDs, fresh list membership check, Login category and website validation |
| Renderer → `browser:list-passwords` / `browser:fill-password` | Trusted Electron renderer; active Browser embed required for fill | Exact origin check in main and page context; metadata or boolean responses only |
| Renderer → `browser:delete-password` / `browser:export-passwords` | Explicit user actions; native save dialog for export | Exact origin and username schemas; owner-only, exclusive export file; boolean responses only |
| Source browser files → main process | Current macOS user and Keychain approval | Read-only SQLite, bounded output and time, supported encryption version only |

No HTTP route is added. No external service receives imported data.

## Resource and failure policy

- Profile discovery is limited to 32 profiles per browser. SQLite input files are limited to 1 GiB; query output to 32 MiB; rows to 10,000 logins and 50,000 cookies. CLI item lists are limited to 2,000. Preview returns up to 5,000 website rows.
- SQLite subprocesses have a 10 second timeout. Keychain access has a 120 second timeout to allow a system prompt. Each 1Password call has a 30 second timeout, and a selected import has a 180 second overall deadline.
- Locked databases may be copied with WAL sidecars to a private temporary directory, deleted in `finally`. The source remains untouched. A failed snapshot reports a generic error.
- Encryption unavailable, including Electron's Linux `basic_text` fallback, means refusing to import passwords. The vault uses an exclusive 0600 temporary file and atomic rename. A corrupt vault is never overwritten implicitly.
- Plaintext export is user initiated and creates a new 0600 file atomically. Existing files are not replaced. Export data remains only on the user's Mac.
- A password batch is written before cookie setting begins. Electron cookies are flushed after import. Cookie failures are counted as skipped, so a partial cookie transfer is an acceptable and visible state. There is no cross-resource transaction between the encrypted file and Electron's cookie store.
- A source login or cookie table failure does not discard selected data from the other table. The UI reports the failed table as skipped. Account transitions close existing embeds; credential operations are gated by the current signed-in Matrix user ID.
- Restored credentials initialize the account-transition guard before a Browser view can open; the first sign-out or expiry closes live embeds. A 1Password vault failure after completed batches returns the completed count, with remaining selections reported as skipped.
- If Keychain access is unavailable for a mixed selection, plaintext cookies can still import; encrypted entries are counted as skipped. A selection with only encrypted entries reports a Keychain error.
- UI messages are generic. Keychain, CLI, SQLite, and decryption errors must not reveal raw paths, account identifiers, item names, or secret values.

## Verification

- Vitest covers Chromium encryption and cookie-domain integrity, malicious URLs and partitioned cookies, selected-site isolation using synthetic SQLite fixtures, the encrypted vault, 1Password item selection, IPC schemas, and current-origin fill gating.
- Electron Desktop build and local Playwright run exercise picker rendering and saved-page import. Synthetic CLI and Keychain fixtures should be used for automated sign-in import; real browser passwords and cookies are never used as test fixtures.
- Separate public docs PR in `FinnaAI/matrix-os-site` updates the Browser import guide with supported sources, macOS prompts, 1Password CLI requirements, best-effort session limits, and how to fill a password.
