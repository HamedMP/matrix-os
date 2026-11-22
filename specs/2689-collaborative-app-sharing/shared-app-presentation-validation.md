# ENG-490 / PR #3451 presentation simplification

[ENG-490](https://linear.app/matrix-os/issue/ENG-490/redesign-share-app-popover-private-organization-public)
· [PR #3451](https://github.com/HamedMP/matrix-os/pull/3451)

The owner gateway generates a bounded PNG thumbnail and carries it with the manifest name in the
existing authenticated directory event. The existing directory row stores presentation atomically
with routing metadata. The read endpoint authorizes the requested scope against fresh membership
and active-share state. Launcher components and their letter/image-error fallbacks are retained.

## Production boundaries

- Source: regular raster file, at most 8 MiB; no SVG/HTML, leaf symlinks, or symlink icon directories.
  Decode limit: 8192 per axis and 16 megapixels. Sharp processing timeout: two seconds.
- Thumbnail: PNG, at most 96×96 and 48 KiB. Its base64 occupies at most 64 KiB; a complete maximum
  routing envelope remains below the unchanged 96 KiB event limit. The outbox measures the actual
  complete UTF-8 event before sending it. Presentation resolution has a three-second deadline.
- Failure: invalid schema, size, dimensions, hash, or decoding drops optional artwork. Local
  presentation failure cannot consume a share delivery retry. Older platforms rejecting additive
  fields receive a routing-only resend. Released strict clients still require `fields=display`.
- Storage: row lock and revision-fenced upsert apply name/bytes/type/hash together. Replay/stale
  events cannot replace newer presentation. The write also predicates owner/runtime, fencing a
  concurrent first insert from a different authority. Replacement clears previous artwork when omitted;
  stop clears its bytes/type/hash. Successful account erasure deletes the directory row and bytes.
- Preview upgrade: convert referenced legacy uploads in batches of 25 before dropping the table.
  Preserve names/revisions and valid artwork, including source bytes above the new thumbnail cap.
  Invalid/stopped/dangling references clear safely. SQL failure rolls back conversion and retains
  the old table. New deployments never create it.
- Read: scope/runtime/hash-confined row lookup, full bounded decode and hash validation, `nosniff`,
  sandbox CSP, ETag, private revalidation, and CDN no-store. Conditional requests also reauthorize;
  outsiders, former members, stopped shares, and missing dependencies fail closed.

## Test changes and rationale

- Removed upload authorization/body-limit/rate-limit/idempotence tests because the upload endpoint
  is gone; its old URL is now explicitly tested as absent. The authenticated directory endpoint's
  identity checks and complete body limit cover the replacement production boundary.
- Removed icon quota, eviction, reference-lookup, and orphan-collection tests because no separate
  icon repository/store exists. Replaced them with atomic replacement/stop, replay isolation,
  account erasure, and preview migration/rollback tests.
- Replaced signature-only fake source artwork with real decoded images, including large artwork
  whose background and distinct mark survive resizing. Added corruption, source-size, dimension,
  symlink-parent, JPEG/WebP conversion, and source-fallback checks.
- Preserved renderer name/icon/fallback tests and strict-client compatibility tests. Directory
  listings are checked for URLs and absence of inline bytes.
- Red evidence: the old implementation failed large/corrupt image checks, final-attempt discovery,
  endpoint removal, thumbnail storage/read, and removal of the separate erasure-surviving table.

## Local validation

Node 24.14.1, pnpm 10.33.4. Tests run one file at a time with one worker and a 512 MiB JavaScript
heap after grouped runs were killed under shared-host RAM/swap pressure. Renderer tests use the
repository's `--no-experimental-webstorage` option. No temporary React deduplication was needed.

| Suite | Result |
| --- | --- |
| Shared-app contracts | 13 passed, including maximum complete-event byte budget |
| Owner presentation resolver | 9 passed |
| Platform icon routes/storage/erasure | 12 passed, including a deterministic competing first-writer authority race |
| Platform directory repository | 10 passed; 2 real-Postgres tests skipped without `MATRIX_TEST_POSTGRES_URL` |
| Preview thumbnail migration | 5 passed |
| Changed outbox presentation cases | 6 passed; 9 unrelated cases filtered |
| Changed launch target presentation case | 1 passed; 18 unrelated cases filtered |
| Five renderer suites | 91 passed initially; one launcher refresh timing failure passed in isolation (92 unique cases) |

Total: 148 distinct focused cases passed through these runs. This is not a full-suite pass.

- Platform package typecheck passed. Canonical full typecheck timed out at gateway; its bounded
  retry did not produce a completed result. Full typechecking remains a current-head CI gate.
- Pattern scan: zero violations, five warnings requiring normal manual boundary review.
- `pnpm install` updated the lockfile; frozen lockfile validation passed. Only the two direct
  Sharp dependency edges were added, reusing version 0.34.5 already in the lockfile.
- Production shell build reached Next compilation but hit the 768 MiB local heap limit and the
  90-second command deadline (exit 124). It is incomplete; current-head CI must pass the canonical
  build. Grouped test runs killed by resource pressure are not counted as completed checks.

## Remaining review gates

Current-head CI and a fresh trusted Greptile result are required. HamedMP's approval of
`8602d3e417093f29f18373cd732a15f6876857c6` predates this simplification and is not approval of it.
Engineering/product review of the updated spec is recommended.

| Surface | Automated name/icon/fallback coverage | Live screenshots and recording |
| --- | --- | --- |
| Web Canvas | passed | pending |
| Web Desktop | passed | pending |
| Electron Desktop | passed | pending |
| Web Mobile | passed | pending |
| Native Mobile | V1 shared app listing unsupported; N/A rationale needs reviewer confirmation | unavailable |

The previously linked `https://app.matrix-os.com/vm/pr-3451` was reported as 404 during review.
No `@Browser` inspection tool is available in this session; no replacement browser tool was used.
No Electron Desktop runtime/capture access is available either. No live qualification is claimed.
The same current-build captures must be attached to the PR and posted in Slack #tech, with that
message's permalink linked back. Historical Slack posts do not prove this build.

Documentation audit: spec, endpoint contract, and data model now describe the simplified design.
The separate public-docs deliverable in `FinnaAI/matrix-os-site` remains listed in the spec; this
refactor adds no public setting or permission. Do not merge, enable auto-merge, or submit approval.
