# Shared app presentation (name and artwork)

Tracking: [ENG-29](https://linear.app/matrix-os/issue/ENG-29). Follows
[launcher-followup.md](./launcher-followup.md).

## User outcome

A current organization member sees a shared app in their launcher with the
owner's display name and icon, plus the existing shared badge. If the artwork is
missing, too large, unsupported, still uploading, or fails to load, the tile
keeps the owner's name and shows the letter fallback. Stopping the share,
leaving the organization, or changing the app removes or replaces the artwork.

## Defect

The launcher only received routing identity (`appId`, `buildId`, ...). Web and
Electron derived the name from the slug, and Electron rendered `url={null}`. The
owner home never published the name or artwork, so the platform had nothing to
serve. Shared launch targets also used `appId` as the `name`.

## Design

1. **Owner source of truth.** The owner home resolves presentation from the same
   app catalog its own launcher uses (`listAppCatalog`): the display name and
   the selected `~/system/icons/<stem>.png`. Only the confined icon filename the
   catalog resolved is read, with `lstat` (no symlinks), from `system/icons`.
   Bundled fallbacks (`game-center.png`, `game.svg`), SVG, and files larger than
   4 MiB are never published. Bytes must sniff as PNG, WebP, or JPEG.
2. **Separate publication.** A `CollaborativeAppPresentationPublisher` on the
   owner home sends a snapshot for each active app binding, every 30 seconds
   and right after start. This is separate from the strict directory event, so
   an older platform rejects it (404/422) and keeps directory delivery working.
   It sends `PUT .../presentation` with the name and artwork digest. If the
   platform reports `artworkRequired`, the publisher uploads the raw bytes to
   `PUT .../artwork/:sha256`. Fingerprints (app, name, digest) are cached per
   scope (capped at 500), and file hashes are cached by path, mtime, and size,
   so unchanged icons are neither re-hashed nor re-uploaded.
3. **Platform storage.** `collaboration_app_presentations` holds one row per
   shared scope, bound to the directory's owner, runtime, and `app_id`. Bytes
   are stored only after the uploaded digest, length, and sniffed type match the
   declared metadata. When the declared digest changes, the old bytes are
   cleared in the same statement. The row is deleted in the
   directory-event transaction when the share stops, needs a recheck, or
   changes `app_id`. A deleted directory row cascades.
4. **Discovery contract.** `CollaborativeAppDirectoryItem` gains an optional
   `presentation: { name, iconUrl? }`. The platform includes it only when the
   client asks with `presentation=1`, because released clients parse items with
   `.strict()` and would reject the whole page. New clients that call an older
   platform get a 422 and retry the same page once without the parameter. A
   missing presentation falls back to the slug-derived name.
5. **Artwork delivery.** `iconUrl` is the same-origin path
   `/api/collaboration/shared-apps/:scopeId/artwork/:sha256`. The digest in the
   path is the cache key: a new icon gets a new URL, and an older digest returns
   404. Responses use `Cache-Control: private, no-cache` with a strong ETag, so
   every view revalidates membership. A 304 avoids the bytes.
6. **Launch.** The shared launch target uses the presentation name and
   `iconUrl`. Both fields were already in the strict launch schema.
7. **Clients.** Shared presentation derivation lives in
   `@matrix-os/ui/collaborative-app-sharing` (`sharedAppPresentation`). Web
   Canvas, Web Desktop, and Web Mobile use the same-origin path. Electron
   prefixes the platform host, where the trusted core injects the bearer token.
   Window and tab titles use the presentation name. Badges, accessible names,
   and existing image error fallbacks are unchanged.

## Auth matrix

| Route | Caller and auth | Checks | Limits and response |
| --- | --- | --- | --- |
| `PUT /internal/collaboration/shared-apps/:scopeId/presentation` | Owner runtime: `x-matrix-runtime-id` + runtime bearer | UUID scope; strict body; directory row is an active `current_membership` app whose owner, runtime, and `app_id` match | 96 KiB body; 204/200 `{ artworkRequired }`; 404 when not shared; generic errors |
| `PUT /internal/collaboration/shared-apps/:scopeId/artwork/:sha256` | Owner runtime: same | Hex digest; allowlisted `content-type`; byte SHA-256 = path digest; sniffed type and length = declared presentation; share still active | 4 MiB `bodyLimit`; 204; 409 on mismatch or stale; 413 when too large |
| `GET /api/collaboration/shared-apps/:scopeId/artwork/:sha256` | Signed-in actor (platform cookie or bearer) | UUID scope, hex digest; fresh current membership of the share's organization; share active; digest is current and bytes are stored | Per-actor rate limit; `private, no-cache`, ETag/304, `nosniff`, `default-src 'none'; sandbox` CSP; 404 for every unauthorized or stale case |
| `GET /api/collaboration/shared-apps[/:scopeId]?presentation=1` | Existing signed-in actor | Existing checks, unchanged | Adds the optional `presentation` field only when requested |

Responses never include owner file paths, runtime tokens, or raw errors.
Recipients never fetch from their own app directory or the owner's home
filesystem.

## Acceptance matrix

| Actor and state | Action | Observable completion | Failure and recovery | Boundary | Surface and lane |
| --- | --- | --- | --- | --- | --- |
| Owner shares an app with a custom name and icon | Publisher cycle | Platform stores name and verified bytes | Platform down or older: retry next cycle; no directory impact | Runtime-authenticated, owner/runtime/app bound | Gateway + platform (PGlite) tests |
| Current member | Opens the launcher | Owner name and icon, shared badge | Missing or broken art: letter tile with the name | Platform membership | UI hook/renderer tests; Web Canvas, Web Desktop, Web Mobile, Electron live captures |
| Owner changes the icon | Next cycle | New digest URL; old URL 404 | Upload interrupted: name still shown, no icon | Digest-bound | Platform tests |
| Owner stops sharing, or member leaves | Loads the artwork URL | 404 | — | Fresh membership, active share | Platform tests |
| Released client | Lists shared apps | Exact strict shape, no new field | — | Opt-in parameter | Contract + platform tests |
| Native Mobile | — | No shared-app launcher exists there (launcher-followup) | Reviewer approval of N/A required | — | — |
