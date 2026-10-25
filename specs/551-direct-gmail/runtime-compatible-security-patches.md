# Compatible runtime security patches

The earlier checkpoints below are historical. The October 24 backport section
records the current remediation scope; older residual counts are not current
audit or release clearance.

ENG-355. Dependency followup to PR2826; this layer is independent of the Gmail feature stack. Keep the base dependency layer and this layer separately reviewable; no history rewriting is required.

The current npm registry reconciliation found additional high/critical families in the installed root graph. This followup applies eligible compatible security patches for the HTTP/database/MCP/auth/WebSocket libraries, parser/utility families and associated toolchain dependencies. Direct dependency minima are updated where owned; transitive overrides stay inside the existing major, and pre1.0 packages stay inside the existing minor. Clerk shared4.x is preserved. Hono and Vite do not receive global peer-rewriting overrides; confirmed pinned WebSocket8 edges are scoped to viem/miniflare. Tiptap React, Markdown, starter/list extensions, core/PM and React's optional bubble/floating-menu dependencies are aligned at3.30.5. The scoped menu overrides avoid selecting newer exact-peer releases against the pinned core. Node-forge1.4.0 removes older advisories but still has an upstream advisory without a fixed release.

pnpm10.33.4 and minimumReleaseAge10080 are unchanged. No age exception or build-script approval is added. Selected fix publication dates and graph exposure are recorded in private ENG-355 evidence, checked against official npm metadata. The root frozen lock is the reproducible source of truth; nested stale lockfiles remain separate work.

## Verification and residuals

The focused installed-library regressions and auth/MCP/runner/renderer checks pass (343 tests across17 suites), along with canonical workspace types and the Next16.4.1 production build using the checked public CI publishable-key fixture. The fixture validates build compatibility; it does not qualify live authentication or provider accounts. Final frozen-lock verification passes. Native Mobile auth/provider regressions pass (183 tests across7 Jest suites); Native Mobile type checking still reports12 diagnostics in ProviderLogo/RabbitMark tests, matching the previously documented baseline locations (this unit did not recreate that independent baseline install). Keep that check red. Exact-head remote CI/review and affected device/binary checks are required before merge/release. Prior-head evidence is not substituted.

Current registry counts for the candidate graph are zero critical,10 high,56 moderate and16 low; `--prod` reports zero critical,4 high,39 moderate and6 low. These are dependency occurrence aggregates, not independently validated exploits. High residuals remain in image-size1.x (requires2.x), nanoid4.x (requires5.x), sharp0.34 (requires0.35), and node-forge/braces advisories without published fixes. The latter two and image-size remain in production-classified Expo/Metro graph paths. Tooling classification does not prove exclusion from host bundles, which copy node_modules. No unsupported cross-major overrides, audit dismissals, production deployment or full-audit clearance are included.

All remaining families need explicit reachability/migration or upstream remediation evidence; the private register lists39 initially high/critical families with dependency routes, selected fix dates and unresolved conditions. Live Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile qualification remains owned by the overall release process; local builds and library tests are not screenshots or recordings.

## Editor compatibility followup

Exact-source remote Electron CI exposed missing ESM exports when React3.22.4 was paired with core3.30.5. A native ESM-import regression reproduces that linkage failure; the same-major desktop editor family is aligned to3.30.5 (published2026-08-26, eligible under the unchanged age gate). An installed-library regression opens nested checklist Markdown, edits the child text and checked state, saves JSON and Markdown, and reopens both formats without mocks. Desktop production bundling and types are checked separately; this does not replace live Electron qualification.

## HTTP/SDK compatibility followup

Full remote CI found stale assumptions after Hono's eager body-limit/parser change and the MCP patch. The chunked relay regression now proves generic413, zero downstream calls/bytes and bounded input reads; direct relay overflow coverage remains. WhatsApp middleware explicitly preserves genericJSON413 for declared and streamed oversized requests, without authentication/linking/ingestion or operational-error logs on early rejection. Device-flow parser failure injection targets HonoRequest.parseBody (the actual boundary) and still requires invalid_request400 with diagnostic logging. The MCP manifest contract tracks the eligible1.32.0 floor. No request-size limits are raised, auth is not bypassed and provider/device flow behavior is otherwise unchanged.


# October 24 compatible backports

ENG-355. These transitive dependencies are present in the host bundle even though
their primary callers are development and signing tools. Presence is verified;
this is not a claim of an exposed Matrix or Gmail authentication vulnerability.

## Scope and source

| Dependency | Advisory | Remediation contract |
| --- | --- | --- |
| `image-size@1.2.1` | [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq), [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) | Keep the synchronous callable, named export, filename and callback API required by Metro. Reject image container records that cannot advance within the supplied bytes. |
| `node-forge@1.4.0` | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | Reject surplus nested DigestAlgorithm children during PKCS#1 v1.5 verification while preserving valid algorithm identifiers with or without NULL parameters. |

The reviewed image-size release fix is 2.0.3, whose major API changes are not a
safe untested transitive override. The forge advisory still has no released fix.
The narrow forge check follows [upstream PR 1152](https://github.com/digitalbazaar/forge/pull/1152/files),
which remains open. A carried patch is not represented as an upstream release.
The [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) was withdrawn
on October 23, 2026; it is excluded from the active residual count without adding
an advisory suppression.

## Verification and packaging

`tests/deploy/dependency-security-backports.test.ts` resolves forge through Expo
CLI and image-size through React Native's community CLI / Metro dependency edge.
Expo's separate Metro 0.84.5 chain has already removed image-size; the React Native
Metro 0.84.4 chain retains 1.2.1. Malformed image inputs run in
fresh subprocesses with a kill deadline so vulnerable synchronous loops cannot
hang a CI worker. The test covers zero, undersized, oversized and container-boundary
records plus valid PNG/path/callback, ICNS and HEIF behavior. Synthetic low-exponent
RSA signatures exercise the nested ASN.1 structural defect and valid SHA-256 cases;
the actual Expo certificate, CSR and manifest signing functions verify compatibility.
No real signing credential or certificate is used.

Forge also ships prebuilt `dist/forge.min.js` and `dist/forge.all.min.js` files.
The same malformed-signature and compatibility tests load each actual UMD bundle
in a bounded VM context. The backport changes the nested count check in all three
entry forms. Both UMD files retain their public API; only their obsolete
`sourceMappingURL` links and the matching two source maps are removed. The prime
worker and its separate source map remain untouched. The minified patch is
generated directly from the exact registry package verified against the frozen
lock integrity; it does not introduce a separately downloaded replacement bundle
or a new compiler. Final artifact checks must confirm all three patched forms
and the exact source-map disposition.

Run red before implementation and green after patch application on remote CI.
Regenerate the lockfile with the pinned pnpm version on remote infrastructure,
then repeat a frozen install. Patch hashes and patch-qualified dependency snapshots
must be retained by the lockfile. Existing dependency patch packaging tests cover
Docker installation and the immutable host bundle's package metadata.

Version-only dependency scanners can continue reporting the original versions
after a compatible patch. Preserve that finding together with patch provenance,
malformed-input regression results and exact artifact inventory; do not mute the
advisories or claim that a version scan alone proves their remediation. Final
qualification requires the rebuilt host bundle/platform image, current full CI,
and live validation of the exact deployed source.

The October 24 remote checkpoint reproduced 15 failures across the 40-case
installed-dependency suite before the complete patch. After patching, all 40
security/API tests and all 10 existing dependency packaging tests passed. The
pinned pnpm 10.33.4 generated the lockfile and a subsequent frozen install passed
in a private remote workspace/store. No build, install, test or scan ran on the
operator's Mac. This checkpoint qualifies the backport behavior and reproducible
installation; it does not replace final-head CI or emitted/deployed inventory.

Remove a carried patch only after upgrading the owning dependency chain to a
supported fixed release and passing these API/security regressions and normal
Expo/Metro build and signing checks. Recommend integration-owner review of this
dependency change. Link the existing public documentation PR for the parent Gmail
processing-policy feature; dependency implementation details belong in this spec.

## October 24 residual nanoid and native image followup

This separate ENG-355 layer closes the remaining nanoid 4 and Sharp 0.34 source
families without suppressing advisories or forcing an unsupported transitive
major. It requires its own final-head CI, review and emitted/deployed inventory.
Historical counts above remain historical.

`patches/nanoid@4.0.2.patch` carries a compatible input-validation backport for
[non-integer sizes](https://github.com/advisories/GHSA-mwcw-c2x4-8c55),
[negative non-secure sizes](https://github.com/advisories/GHSA-28wg-ghj8-5hjv),
[zero custom sizes](https://github.com/advisories/GHSA-2v37-7h3g-55p8), and
[entropy-pool overflow/corruption](https://github.com/ai/nanoid/security/advisories/GHSA-xwg4-73v4-xw9w).
There is no fixed nanoid 4 release. The patch preserves the published 4.x module
paths, valid numeric sizes, default 21-character IDs, custom alphabet/random
APIs and asynchronous/native variants. It rejects fractional, negative,
non-finite and signed-32-bit-overflow sizes before entropy access or iteration;
zero custom-generator calls return an empty result without requesting entropy.
Other zero-size random/ID entrypoints retain their existing provider calls with
empty buffers where applicable. A failed Node entropy fill clears the pool before
reuse. Custom generators preserve their original nonzero-default sampling batch
and rounding. Only a zero default uses the validated positive invocation size as a
fallback. Browser entropy batches are capped at WebCrypto's 65,536 bytes, and
native batches at Expo Random's 1,024 bytes; Node zero-default fallback batches
are bounded at 65,536 bytes while existing nonzero-default Node batches remain
unchanged. These caps do not limit the requested ID length. The standalone
browser file receives the same guard without adding an import. The CLI delegates to the guarded implementation.

The fixed upstream releases informed the narrow security changes; the patch
retains the nanoid 4 sampling algorithm and does not replace it with nanoid 5.
`tests/deploy/residual-nanoid-security.test.ts` executes every shipped Node,
browser, non-secure, async, async-browser, async-native and standalone-browser
implementation in a child with a kill deadline. The sole native bridge fixture
supplies actual CSPRNG bytes and enforces the 1,024-byte limit verified in the
[official `expo-random@13.1.1` source](https://registry.npmjs.org/expo-random/13.1.1)
instead of loading that optional package; this
is algorithm coverage, not Native Mobile device qualification. The suite also
executes the real Mermaid converter's graph-image path and verifies generated
file IDs retain their exact element/file linkage. Initial unpatched execution
reproduced 12 failures across 22 cases; the patched fresh frozen installation
passes all 33 cases including the real consumer regression, large valid
overrides and entropy-failure recovery during initial fill, refill and growth.
The initial entropy failure is also red against the original package. Review
found that the first patch recomputed batches from large invocation overrides,
exceeding browser/native per-call quotas. Additional red checks reproduced the
regression before the compatible default-preserving, quota-bounded correction.

Sharp's affected native libraries cannot be fixed with a JavaScript-only patch.
Two owner-scoped overrides select `wrangler@4.149.0` for edge-router and
neo-worker. This same-major vendor parent selects
`miniflare@5.20261006.1-alpha`, `workerd@1.20261006.1` and `sharp@0.35.5` itself;
there is no direct Sharp or Miniflare override. Their official npm publication
and integrity records are verified, and all new selected releases satisfy the
unchanged seven-day minimum release age. No script approval or age exception is
added. The final lock contains no Sharp 0.34.5/native 0.34.5 dependency snapshots.

The selected Miniflare is a prerelease with a changed Node constructor API.
There is no Matrix application Miniflare constructor caller to migrate. The
compatibility test explicitly invokes its vendor-exported
`convertV4MiniflareOptions` bridge, starts the real workerd process bound to
loopback on an ephemeral port, checks worker health and sends valid/invalid
image bytes through its actual Images binding and Sharp decoder, then disposes
the emulator. Existing edge-router, preview-router and neo-worker contracts pass;
all three existing Wrangler dry-run build scripts and both worker typechecks
pass without deployment or cloud credentials. Wrangler's optional
`@cloudflare/workers-types` peer now expects major 5; the existing major 4
application types remain unchanged and both consumers typecheck successfully.
Integration-owner review of this prerelease transition and optional type-peer
mismatch is recommended.

The actual Linux library inventory is Sharp 0.35.5, libvips 8.18.7,
libheif 1.23.5 and librsvg 2.63.2, above the maintainers' fixed floors for
[libvips](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj),
[libheif](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
and [librsvg](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w).
Tests inspect loaded native versions, reject truncated images and enforce an
explicit pixel limit, and preserve SVG/PNG/AVIF decode/resize behavior. These are
native-version and consumer regressions, not exploit reproduction of every
upstream native CVE. Other supported platform packages remain locked but need
their normal platform-specific artifact verification.

All installs, lock generation, decoder/emulator executions, tests and dry-run
builds ran on the remote test host in a dedicated workspace and private stores,
with pnpm 10.33.4 and a subsequent fresh frozen installation. The first patch
iteration exposed a malformed no-newline hunk; a corrected patch and clean store
verified the actual patched installed bytes. No operator Mac build or test ran.
Retain the carried nanoid finding and provenance when a version-only scanner
reports 4.0.2; remove the patch only after its owning chain moves to a supported
fixed release and these consumer regressions pass again.
