---
status: active
---
# Gallery redesign and working installation

User expanded the task: the gallery in Web and Electron needs a complete redesign, installation currently fails, and icons must follow the linked Matrix brand moodboard.

Brand reference: Figma xPG2FeYRtC9owCKSVXCqWA node 1:545. Direction: nature, organic shapes, restrained forest green, sage, clay, amber, pearl. Playful but refined, modern and artistic. Use existing @matrix-os/brand tokens. Warm sculpted objects retain recognizable purpose-specific silhouettes.

## U5 — Full shared gallery redesign
Goal: a premium curated app library with real app previews, distinct app identities, coherent Matrix brand and install states. Same source renders in Web and Electron; mobile layout is first-class.
Files (worker ownership): home/apps/app-gallery/src/App.tsx, App.css, GalleryResults.tsx, Preview.tsx; new focused presentational components in this folder; tests/default-apps/gallery-redesign.test.tsx if needed. Do not edit model.ts, generated data, gateway, icon assets, manifests, shared utility CSS.
Approach: concise App Gallery header and clear Personal/Business tabs, distinctive featured app section, app rows/cards that show the actual app UI preview rather than generic cover icons, useful connection badges, coherent app details, visible install progress/error/retry, modern restrained typographic hierarchy. Preserve real actions and catalog/filter semantics. No invented popularity, ratings or integrations. No pretending sample data is owner data. Reuse existing screenshot assets if available and verify their app identity; otherwise actual preview sources must remain honestly labeled. Keep bridge calls delegated to existing model.
Execution note: tests first for behavior changes. CSS-only layout validation uses screenshots/builds. Shared-directory worker must not stage, commit or run project suites; root handles checks.
Patterns: existing gallery races tests and model derivations, packages/brand tokens, connected app identity source.
Test scenarios: category and readiness filtering, empty/error/loading, installed open, installation retry, detail dismissal, keyboard access, 390px and large viewport.
Verification: source builds, focused checks pass; actual Web and Electron preview screenshot. Root reviews design against brand and validates no functional regressions.

## U6 — Installation root cause and fix
Goal: installation succeeds from both Web and Electron against the disposable preview computer, and failed installs remain recoverable.
Files (worker ownership): existing gallery-related gateway services/routes, model.ts if required, native app gallery bridge modules if required, targeted gateway/desktop/model tests. No changes to U5 files, core icon rendering or any app interior CSS. Report exact candidate files before edits.
Approach: first diagnose exact request flow and installer/build/catalog source; inspect preview-env skill if reading VPS logs. Add a failing test for the demonstrated root cause before minimal implementation. Preserve permissions, auth, atomic install and owner data. Do not weaken sandbox, use production deployment, fabricate installed success, or archive/delete user data. Coordinate tests with root in shared worktree.
Test scenarios: actual failed install trigger, authenticated exact runtime routing, build/package error propagation, successful installed manifest and launch path, retry/idempotence, no cross-owner write.
Verification: regression red/green, real disposable-runtime install/open test for a no-integration app and one integration-backed empty app; no provider data import until separately authorized.

## U7 — Brand/icon/preview integration (root)
Goal: finish canonical icon family and default app interiors, align gallery redesign, make reviewable stacked PRs and disposable preview release. Public docs update in FinnaAI/matrix-os-site is a separate deliverable. No production deployment or merge.
Files: remaining icon/brand/renderer files listed in original plan; specs/evidence; separate site repo docs.
Execution note: focused tests before resolver changes. Existing owner-customized icons remain untouched. Root runs cross-unit tests/builds after parallel batch.

Parallel safety: U5 source presentation and U6 installer/model/backend ownership do not overlap. Root U7 owns core launcher/resolvers/icons and not gallery model/presentation. Workers report any discovered overlap before editing; shared-directory workers do not stage/commit or run suites.
