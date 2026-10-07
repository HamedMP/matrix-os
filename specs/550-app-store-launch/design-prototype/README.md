# Matrix App Store design exploration

A React/TypeScript design review artifact for spec 550. Opens the premium/minimal storefront selected as a direction on October 6; earlier A–C explorations remain available for comparison. It now shows the refreshed source interfaces directly, plus a comparison studio for eight store apps and nine everyday Matrix apps. Each has previous/refreshed editions and phone, tablet and desktop viewports, all with fictional records. The original screenshots remain historical assets; current cards use scaled live interfaces, not a claimed screenshot capture.

**This does not connect accounts, install apps, import owner information or submit ratings.** Connection, account-label, permission and rating steps are explicitly example interactions held in memory. Reload resets them. The production OAuth, store routes, install receipts/ratings, bespoke app releases and Native Mobile host remain work in the launch plan.

## Run

Use the repository's Node 24 and pinned pnpm setup; no additional dependency installation or lockfile is needed beyond `pnpm install --frozen-lockfile` at the repository root. From this directory:

```sh
pnpm exec vite --host 127.0.0.1 --port 3036
pnpm exec tsc -p tsconfig.json
pnpm exec vite build
node public/demos/verify.mjs
node --test checks/*.test.mjs
node checks/check-ui.mjs
node checks/check-demos.mjs
```

The browser check uses the existing Playwright dependency and a separately launched headless Google Chrome profile. It never attaches to the user's browser. `PREVIEW_ORIGIN` can point it at another locally running preview. Browser launch and local-server access must be permitted by the execution environment. The check closes every context and browser in `finally`.

The dependency-free catalog tests verify suggestions, normalization and caller-provided collection boundaries. `check-ui.mjs` separately checks actual rendered search results: “trips” shows Atlas, Business hides it while retaining the query, and All apps restores it. Those added browser assertions were authored and syntax-checked, but not executed in the October 7 review because gallery browser access was denied. They remain pending until run in an authorized environment; do not use another browser route to bypass a denial.

`check-demos.mjs` reproduces the 16 embedded flows: eight apps at outer 360/390 pixels, with the actual measured frame widths, physical create/edit/reopen/reset, 44-pixel controls, opaque isolation and browser-enforced blocked form POSTs. The adjacent design evidence also records 16 earlier direct-page phone checks, giving 32 recorded runs; this committed harness focuses on the stronger embedded boundary. `verify.mjs` independently checks temporary data/CAS/bounds and exact copied-asset digests. Local Check records usability is checked through physical browser clicks, not a disconnected mock button.

Vite's relative build base allows the built artifact to be served under a directory. Serve `dist/` over HTTP; opening HTML directly from a file URL is not supported. The root build ignores this design artifact; it adds no production route, package, migration or runtime dependency.

## Asset provenance

- The eight WebP screenshots were captured from the actual connected starter's UI with fictional example records for the pending 549 foundation. They are copied unchanged from `home/apps/app-gallery/src/previews/<id>.webp` in the validated foundation checkout. They are not the bespoke hero designs proposed for launch.
- `public/demos/provenance.json` records the actual compiled React/CSS assets and digests. [Demo README](public/demos/README.md) documents its temporary adapter, bounded capabilities, sandbox and one exact preview-copy adaptation. No owner/source account content is included.
- The two local font files are Instrument Sans Latin variable normal and Instrument Serif Latin 400 normal, supplied by the repository's existing Fontsource packages (`@fontsource-variable/instrument-sans` 5.3.0 and `@fontsource/instrument-serif`; package licensing applies). Their original OFL licenses accompany them in `public/fonts/`. Files were copied unchanged from the existing Matrix build; no remote font request occurs.
- Matrix chrome/setup consumes `@matrix-os/brand` through the prototype Vite alias. App screenshots retain their actual source app styling.

## Review boundaries

The phone demos use a separate opaque sandboxed frame and fictional temporary data. They never receive an owner bridge or credentials. CSP and the fixture transport policy forbid source/kernel/API calls; reload restores the fixtures. Temporary interaction is not owner persistence. A desktop browser preview cannot verify Native Mobile, keyboard/safe-area or native Back behavior.

Read the adjacent specification, onboarding UX and design document before turning this artifact into production behavior. Production previews need a separately reviewed credential-free origin, immutable release identity, response-header policy and real host/proxy integration checks.

## Refresh packaging and review

`checks/package-design-demos.mjs <connected-source-checkout> <default-source-checkout> <original-default-source-checkout>` packages the actual sources into 34 credential-free source documents. The default baseline is archived from commit `237e25fae`; connected baseline HTML and its unmodified production bundle are retained under `public/baseline/connected`. Connected refreshed assets are copied unchanged from their production Vite output; defaults use their actual `src/main.tsx` entry bundled into a classic IIFE so Notes' lazy editor also works in an opaque frame. No alternate display implementation is used.

The parent lazily imports each document, then assigns it to an opaque `srcDoc` iframe. This avoids a nested authenticated app navigation; it adds no host permission, proxy exception or owner capability. The defaults adapter supplies bounded temporary tables/KV and a clearly labeled fixed weather example. Closing or resetting the frame discards edits. A 30-minute TTL caps retained default fixture state. VM/helper checks validate all document digests, syntax, CSP strings, bounds and fixture behavior; actual browser CSP and rendered results remain pending.

`?review=apps` opens the comparison immediately. The new browser harness uses the titled srcDoc frame and opens the compact Filters & connections panel before searching. The current harness has not been executed since the access denial. Current screenshot capture and Matrix Expo validation are also pending; historical evidence cannot be reused as proof of these new layouts.

A separate **App Design Studio** app can be staged in a Matrix computer for review. It contains this compiled review interface and fictional examples, rather than replacing any installed owner app. Source candidates, launch readiness and release approval remain separate.
