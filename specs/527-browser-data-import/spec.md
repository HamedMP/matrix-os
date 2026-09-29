# 527: Import local browser pages into Electron Desktop

## Goal

Give Electron Desktop's Matrix Browser an import flow for saved local browser pages. Users choose a detected browser profile, import its pages, search the resulting Saved pages list, and reopen pages in Matrix Browser. The source browser remains unchanged.

## Supported sources

| Source on macOS | Imported data | Reader |
| --- | --- | --- |
| Arc | Tabs in the current local sidebar snapshot | `StorableSidebar.json` |
| Chrome, Brave, Edge, Vivaldi, Opera, Chromium | Bookmarks from detected local profiles | Chromium `Bookmarks` JSON |
| Safari | Bookmarks | `Bookmarks.plist` via macOS `plutil` |
| Firefox | Bookmarks | Profile `places.sqlite` via read-only macOS `sqlite3` |

Each adapter discovers only a fixed browser-owned location under the current macOS user's home directory. The renderer supplies a bounded source ID, never a file path. Malformed, unavailable, or permission-protected sources are omitted from discovery. Imports can be repeated; URL deduplication keeps the saved title and folder already in Matrix.

## UI and state

- Browser settings links to **Import from another browser**.
- Discovery shows a source and profile with the number of importable pages. The user initiates the selected import.
- Imported pages appear in **Saved pages**, remain searchable, and persist with other local Electron Desktop Browser state. Selecting one opens it in Matrix Browser.
- A public page opened in Matrix Browser can be added to the same list with **Save**.
- The import screen describes the actual scope: site sign-ins, passwords, and extensions stay in the source browser. Matrix Browser still has no password vault.
- When the Browser's eight live tabs are full, opening a saved page replaces the active tab. The saved page remains in the list.

## Auth and security boundary

| Entry point | Caller | Authorization | Data returned |
| --- | --- | --- | --- |
| `browser:list-import-sources` IPC | Trusted Electron Desktop renderer through preload | Main-process handler registration and strict shared IPC schema | Browser/profile labels and counts only |
| `browser:import-pages` IPC | Trusted Electron Desktop renderer through preload | Strict source ID allowlist, resolved to a known local path in main | HTTP(S) page title, URL, and folder only |

There are no HTTP routes or gateway writes. Neither channel accepts arbitrary paths, cookie values, credentials, or raw browser database rows. Input and response schemas reject extra fields. The main process caps source file size, page count, title/URL/folder lengths, and subprocess time and output. JSON reads reject final-component symlinks. URLs with non-HTTP schemes or embedded credentials are discarded. Source files are read-only and are never copied to the user's VPS or the agent's separate Playwright profile. Import errors shown in the renderer are generic.

## Deferred credential migration

Importing active site logins requires a separate security design for per-site consent, protected cookie stores, storage beyond cookies, browser profile identity, and tests proving no credential enters renderer IPC, analytics, logs, or the agent browser. Password import additionally requires Matrix Browser's encrypted password vault. Neither is implied by saved-page import. History and extension import require Matrix Browser destinations and compatibility handling before they can be offered.

## Verification

- Test-first parser and bounded source-discovery tests use temporary fixture homes and synthetic browser data.
- Shared IPC contract and handler tests verify exact source IDs, rejected paths, response validation, and registration-time dependency wiring.
- Electron Desktop component tests import a source, persist Saved pages, remount, and open an imported URL.
- Desktop main and renderer typechecks, production build, and a Playwright Electron Desktop test against a synthetic local Arc profile validate packaging, UI layout, and the full import/open path.

## Public documentation

Publish a separate `FinnaAI/matrix-os-site` documentation PR describing the import steps, supported browsers, data types, and sign-in limits. Link it from the implementation PR.
