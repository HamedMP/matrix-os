# Selected device files and import previews

Selected files remain owner-controlled raw files. Uploading creates no app records or AI calls. Shared upload state captures owner/computer runtime and destination at selection, caps 32 items/three active sends, validates UTF-8 names and relative paths, and exposes queued/uploading/failed/cancelled states with retry/cancel/remove. Runtime changes or component teardown cancel requests and release cached picker copies. Requests have a 30-second deadline and a 10 MiB file/body limit. Exclusive staging plus atomic link prevents concurrent same-name uploads from overwriting owner files; staging files are deleted on success/failure.

## Runtime wiring and parity

| Surface | Upload composition | Normal preview |
| --- | --- | --- |
| Web Canvas | Shared `shell/src/components/file-browser/FileBrowser.tsx` → `UploadFromDevice.tsx` | Shared PreviewWindow and Files side preview |
| Web Desktop | Same shared Files composition | Same shared previews |
| Web Mobile | Same shared Files composition | Same shared previews adapted by existing presentation |
| Electron Desktop | ComputerFileBrowser → use-file-uploads → shared queue adapter → authenticated ApiClient raw PUT | FilePreviewPane; existing CSV/TSV table plus completed PGN text summary |
| Native Mobile (iOS/Android) | Root/modal Files → FileCreationControls → SelectedDeviceUploadPanel → lazy selected-device-files | ComputerFilePreview; shared CSV/TSV/PGN summary plus unchanged source |

All queues use `@matrix-os/contracts/file-upload`; source summaries use `@matrix-os/contracts/selected-import-preview`. Native requests bind the selected computer gateway path (including runtime query), acquire its owner Clerk token, and verify uploaded path/bytes. Web uploads use selected runtime URL and owner session/token; Electron uses the owner ApiClient and checks scope immediately before transport. Filenames and file bodies are analytics-masked. Activity state is phase-based, not invented byte progress.

## Endpoint auth matrix

| Route | Authentication and authorization | Public | Limits |
| --- | --- | --- | --- |
| `PUT /api/files/blob?path=…` | Existing gateway owner auth/principal and home/path/project guards | No | bodyLimit 10 MiB; safe UTF-8 path/name; staged atomic write |
| `GET /api/files/import-preview?path=…` | Existing gateway auth plus required principal, owner-home resolution | No | 512 KiB regular file; no final symlinks; pinned bounded read; unchanged size/mtime |

Missing principal dependency fails 503. Invalid input, missing files, malformed exports, and changed-during-read files receive safe errors. Preview descriptors close on every path. This read route is available headlessly; normal client previews reuse their existing authenticated file reads and pure shared parser without extra network/provider calls.

CSV/TSV parses at most 100 rows, 64 columns, and 2 KiB/cell. Formula-like text remains inert. PGN supports a single completed game, at most 32 tags and 32 KiB notation; incomplete/ambiguous inputs fail safely. No chess engine or legality evaluation occurs. Original sources are preserved and visible independently.

## Native permissions and release limits

Expo document/image picker modules require rebuilt Native Mobile clients. Picker imports are lazy so older binaries show a recoverable failure. Documents use the system document picker with private cache copies; images use the selected modern photo picker (`legacy: false`, images only, no EXIF/base64). Upload paths never call media-library permission APIs. Cleanup only deletes files inside Expo cache, never originals.

Existing QR camera and voice microphone permissions/purpose strings remain. Seven broad storage/media permission entries are blocked in Android configuration. Expo config introspection verified their `tools:node=remove` entries and no new health/alarm/background entitlements. Installed Android implementation uses AndroidX PickVisualMedia and system ACTION_GET_CONTENT fallback, without broad library permission requests. Physical-device picker/OAuth checks remain separate release validation.

HealthKit, Health Connect, AlarmKit, background/device-wide contacts, photo-library synchronization, direct Hevy authorization, and chess-engine analysis remain deferred. No App Store version, release channel, or unrelated entitlement changes are included.

## Focused evidence

Authenticated gateway tests exercise real selected raw upload → import preview and verify unchanged CSV/PGN bytes. Tests cover concurrent no-overwrite, malformed names/paths, size caps, stale-runtime queues, cancellation, retry, generic failures, privacy masking, system picker options/cache cleanup, bounded parsing, UI summaries, and supported file formats. Native Jest with `--detectOpenHandles` terminates cleanly.

Native TypeScript baseline was compared in-memory against HEAD source using the same installed dependencies: HEAD 46 diagnostics, changed source 46, zero added or removed by file/code/message. Existing errors concern Image/Swipeable/Svg/WebView React types, GestureHandlerRootView/PostHog mask props, and ColorSchemeName. Newly added upload modules have no diagnostics.
