# Utilities toolkit

## Goal

Group the existing tools into one searchable Utilities app in Matrix and improve their input, preview and export workflows.

## Requirements

- R1: Word/character counts update as text changes, including zero counts for empty input.
- R2: Find/replace uses explicit fields and literal replacement; JSON to CSV includes columns from every row, delimiter/header controls, formula-safe export and table preview.
- R3: CSV to PDF supports device file input and editable preview; existing QR and image-compression journeys remain usable.
- R4: Website hub/detail CTA says **Get Matrix**, links to `/desktop`, and distinguishes the desktop client, paid cloud computer, local processing and website-only advanced tools.
- R5: One manifest-discovered Vite/React Utilities app exposes search/categories and the canonical 104-tool catalog in Web Canvas, Web Desktop and Electron Desktop. No shell-specific registry or duplicate engines.
- R6: Shared toolkit is pinned to an exact website revision and content hashes, with repeatable import and verification. Keep app-only integration adapters explicit.
- R7: Tool input/results never enter website analytics from Matrix. Files are ephemeral; results require explicit copy/download. Audio recovery does not introduce IndexedDB persistence.
- R8: Preserve the opaque-origin app sandbox. Where workers, media or runtime restrictions prevent an advanced tool from working, show an explicit platform limitation and website link before accepting input. Do not relax the parent Electron policy or add allow-same-origin.
- R9: Tests, production toolkit build, responsive browser checks, implementation PRs and a separate canonical website documentation PR are required.
- R10: Each tool and the Utilities launcher have semantic artwork following [Matrix's latest icon design](https://github.com/HamedMP/matrix-os/pull/2304): transparent backgrounds, varied silhouettes, rich colors, restrained highlights and depth. Website and Matrix use the same pinned vector artwork; the launcher resolves an actual Utilities icon asset.

## Runtime wiring and security

`home/apps/utilities/matrix.json` is discovered by the existing gateway/app launcher, and the app-store listing points to the same app. Host release builds include the compiled Vite output and build stamp. Build source globs stay inside the app so copying the template into an owner home does not invalidate the stamp. The host's exact toolkit build dependencies live in `packages/utilities-runtime`.

No new API, database schema or mutating endpoint is introduced. Existing `/apps/:slug/*` and app-session authorization remain the source of truth. File inputs use explicit browser selection; exports use browser downloads. Existing source toolkit limits/timeouts remain in force. Neither tool input nor output is sent through the OS bridge. Cross-origin model/runtime access is scoped to Utilities where supported, with exact origins; other apps keep their existing policy.

The privileged Utilities route is reserved for the OS-bundled app. Community installs, uploads, forks, and renames cannot claim or replace its identity, including manifest aliases in other directories. The owner retains direct control of their files.

Web Canvas and Web Desktop share AppViewer and the same availability derivation. Electron Desktop uses the same Utilities bundle; model downloads cannot bypass the packaged renderer policy. Native Mobile and Web Mobile use the responsive app layout wherever the existing app launcher exposes Vite apps; no new native tool integration is introduced.

## Data and lifecycle

Input/results are owned by the user and held only in the current workspace. Leaving an edited workspace requires confirmation; cancel retains the active component and input. Reload closes an ephemeral audio session. No database transactions or new persistence are needed. No acceptable durable orphan state is introduced.

File drops mark the workspace edited. The app reports only its dirty boolean to its actual parent frame; the shared window-close guard in Web Canvas, Web Desktop, Electron Desktop and Web Mobile keeps the iframe mounted until the user confirms closing. Native Mobile's independent web preview does not participate in that shell close protocol; users must save before navigating away there. Pending transformations publish results only while their input version remains current.

## Reproducible source

Run `node scripts/sync-utilities-toolkit.mjs /path/to/matrix-os-site` from a clean committed website checkout; `--verify` verifies the generated output and launcher artwork. Source manifest records website revision, original hashes and adapted hashes; a regression test verifies the actual shipped files. Do not hand-edit generated vendor sources. Source import adapts website imports, bundled asset URLs, no-op website telemetry and the explicitly ephemeral audio adapter. Canonical branded tokens continue through `@matrix-os/brand`.

## Verification and delivery

Focused tests exercise real catalog dispatch, empty/search/category navigation, unsaved input retention, manifest discovery, import/path adaptation, tamper detection and scoped iframe/static policy. Browser smoke covers counts, JSON/CSV union keys, CSV/PDF, find/replace, QR, compression, search, categories and narrow widths. Unsupported advanced tool states must be checked in the app sandbox.

Public documentation ships as a separate PR in `FinnaAI/matrix-os-site/content/docs/`. Implementation and docs stay behind the repository's normal review/Greptile gate; publishing/deployment is coordinated after review.
