---
status: active
---

# Matrix App Gallery, desktop widgets and funded images

Use the user's six October 7 references as visual direction: a soft blue/pink desktop backdrop, rounded translucent navigation, expressive app icons, generous real app previews and subject-specific widget layouts. Create original Matrix work. Adopt the naming memo: installed **Apps**, discovery **Matrix App Gallery**, connected **Tools**, copyable **Templates**. Community executable publishing remains future scope.

## Independent implementation units

### U1 — Platform-funded Nano Banana 2.1
Goal: an authenticated, bounded platform image service reachable through Matrix's existing image-generation capability, with provider credentials kept on the platform. Support the official `gemini-nano-banana-2.1` model using its documented Interactions API. Preserve explicit BYOK compatibility. Failure must close funding/dispatch, never silently spend through another source.
Files: packages/platform/src/image-generation/**; gateway image transport; packages/kernel/src/image-gen.ts and image IPC registration; shared contracts, provisioned host configuration where necessary; corresponding tests. Worker may extend narrowly required platform route/startup and database migration wiring. Parent owns this plan and widget spec.
Approach: inspect existing runtime-bound speech credentials and durable funding/admission before choosing a separate domain or extension. Provider requests need timeouts, response caps, exact schemas, canonical image checks, generic errors, bounded concurrency, idempotency and durable reservation accounting. No platform key sent to owner runtimes or web clients. Explicit platform enablement/allowance is required; do not invent unrestricted free spend.
Execution note: test-first. Verify official Google API response and pricing before implementation; mock the provider for deterministic tests, and report live activation separately.
Patterns: packages/platform/src/speech/, packages/gateway/src/speech/platform-client.ts, packages/kernel/src/image-gen.ts.
Test scenarios: correct model/body, unauthorized and cross-owner runtime, malformed/oversize input and provider output, duplicate/replayed request, concurrency and timeout, disabled config, insufficient allowance, exact image save, legacy explicit BYOK.
Verification: focused contract/unit/integration tests and package type checks. Runtime registration/startup must use real dependencies. Document any activation prerequisites; no release/deployment in this task.

### U2 — Gallery and widget design preview
Goal: replace the current gallery's repeated dashboard presentation with the reference direction while retaining genuine packaged app previews, search, useful personal/business filtering, connections and comparison views. Add an interactive desktop widget design view with add/remove/rearrange and subject-specific cards; clearly fictional demo data.
Files: specs/550-app-store-launch/design-prototype/** in /private/tmp/matrix-gallery-widget-design only. Own source, CSS, demo catalog tests and preview documentation. No changes to production shell, kernel or owner records.
Approach: four generous preview columns on wide screens, adaptive one/two-column phone/tablet view; pill navigation for Gallery, Tools and widget preview. Expressive original icons and each subject's own layout. Preserve existing real source preview documents and source provenance. Avoid fabricated screenshots, ratings, install claims or community listings.
Execution note: test-first for new navigation/filter/widget state; source checks and production build for visuals. Browser access to the gallery target has been denied: no browser/CDP/Playwright/curl/screenshots of that target or alternatives to bypass it. Rendered and native checks remain pending.
Patterns: Storefront.tsx, DesignReview.tsx, DemoFrame.tsx and PreviewDocument.tsx in the prototype.
Test scenarios: valid tabs, filters, empty query, widget add/remove/reorder and bounded state, phone layout source invariants, real previews still resolve.
Verification: Node checks, TypeScript and Vite production build. No owner app overwrite. User can review the preview manually.

### U3 — Public gallery, landing catalog and useful search tools
Goal: a public, indexed Matrix App Gallery linked from the landing page and a working browser drawing/whiteboard tool inspired by the Excalidraw use case. Distinguish available browser tools from reviewed Matrix app candidates; community sharing is future scope with opt-in review/withdrawal requirements.
Files: private site repository /private/tmp/matrix-public-app-gallery-tools: src/app/apps/**, app catalog and landing components/routes/nav, src/app/tools/** and existing free-tools catalog/engine as narrowly required, public first-party review assets, tests, content/docs/**. No Matrix backend files.
Approach: use public-safe fictional first-party assets, helpful crawlable app pages and descriptions, canonical metadata and sitemap integration. No external owner data, fake community counters or published availability promises. A working drawing tool should use existing editor/canvas libraries when present; research official Excalidraw license/runtime before adding dependency. Include companion public docs covering gallery, widgets' planned boundary and funded images' activation truth.
Execution note: test-first for catalog, routing and tool behavior. Build and tests required; read site AGENTS.md and check 375/768/desktop if UI tools permit. Do not inspect the denied gallery target through another tool.
Patterns: existing src/app/tools, free-tools/catalog.mjs, SiteHeader, landing theme and publicPageMetadata.
Test scenarios: catalog URLs/canonical metadata, no promised unqualified runtime, tool content and export/persistence handling, responsive layout constraints, browse/filter states.
Verification: site test suite and production build. Rendered checks pending if tool policy blocks them; report truthfully. Separate private-site PR is required.

### U4 — Widget architecture and integration review (parent)
Goal: concrete widget implementation spec for shared Web Desktop/Electron Desktop/Web Canvas, plus mobile presentation, updates/cache/permissions and owner persistence. Read actual desktop config and app bridges before designing it. Integrate and review U1–U3 and open scoped PRs.
Files: specs/552-gallery-widgets-platform-images/{spec.md,plan.md,verification.md}; scoped integration fixes after workers finish.
Execution note: architecture verification from actual source, focused regression tests for integration fixes.
Verification: auth matrix, runtime wiring, explicit release gates, source review, required automated review, separate public docs PR. No fabricated platform/Expo support.

## Parallel safety
U1 and U2 have deliberately isolated Matrix worktrees; U3 is a separate repository/worktree. No file intersections. U4's specification files are parent-owned. Existing completed PR heads remain intact and unmerged. Dependent integration and review happen after implementation; preserve all unfinished worktrees.

## Release boundaries
This task prepares source and reviewable designs. Native Mobile end-to-end save/reopen, screenshot evidence, platform funded activation and deployed qualification are separate gates. Gallery preview browser access is policy-blocked and must not be bypassed. Installed first-party free apps need explicit qualification before October 15; community executable publishing is deferred.
