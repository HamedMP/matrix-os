# PR Invariants: Attached Terminal Rich Paste

## Source of truth

- Local files and macOS clipboard bytes are read only by the local CLI during an observed paste transaction.
- Remote paste assets are owner-controlled files under `~/projects/.matrix-terminal-pastes/` in the authenticated Matrix home.
- No database or platform-owned object store is added for paste assets.

## Lock/Transaction Scope

- Each accepted image is written with an exclusive temp file and atomic rename.
- Multipart upload validation happens before any prompt rewrite reaches the attached WebSocket.
- Network upload happens before terminal input forwarding; the terminal stream is not used to carry local image bytes.

## Acceptable Orphan States

- If one asset write succeeds and a later write fails, the completed file may remain under `.matrix-terminal-pastes/`.
- Orphaned paste files are acceptable because they are owner-visible temporary files and are pruned by max-age and max-count cleanup.
- Failed local validation or upload returns local feedback and forwards no detected local image path.

## Auth Source of Truth

- `POST /api/terminal/sessions/:name/paste-assets` uses the existing gateway auth middleware shared by `/api/terminal`.
- Session names are validated at the route boundary before the paste asset service writes paths.
- Auth failures use the gateway's existing generic auth response path.

## Resource Limits

- Mutating paste asset upload uses Hono `bodyLimit` before multipart parsing.
- A paste transaction accepts at most five images.
- Each image is capped at 10 MB and must match a supported image signature.
- Cleanup skips symlinks with `lstat()` and clears its recurring timer on gateway shutdown.

## Deferred Scope

- Browser shell and mobile rich image paste are not included.
- Terminals that emit no stdin bytes and no bracketed paste boundary cannot trigger image-only clipboard upload.
- Clipboard image reading is macOS best-effort through `pngpaste`; no global clipboard polling or keyboard hooks are added.
