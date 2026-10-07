# Matrix App Gallery and widget design preview

A React/TypeScript design review artifact for spec 550. Opens the original Matrix gallery direction based on the six October 7 references; earlier A–C explorations remain available for comparison. It shows the refreshed source interfaces directly, plus a comparison studio for eight gallery apps and nine everyday Matrix apps. Each has previous/refreshed editions and phone, tablet and desktop viewports, all with fictional records. The original screenshots remain historical assets; current cards use scaled live interfaces, not a claimed screenshot capture.

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

The dependency-free catalog tests verify suggestions, normalization and caller-provided collection boundaries. `check-ui.mjs` separately checks actual rendered search results: “trips” shows Atlas, Work hides it while retaining the query, and All apps restores it. Those added browser assertions were authored and syntax-checked, but not executed in the October 7 review because gallery browser access was denied. They remain pending until run in an authorized environment; do not use another browser route to bypass a denial.

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

## October 7 review corrections

Ten Node checks and three focused component checks pass; TypeScript, production Vite build, demo integrity checks and browser-harness syntax pass. Preview load failures are visible and retryable, atomic bulk updates reject an entire invalid batch, revenue labels align with points, and phone frames use a real 390-pixel document viewport. The browser harness selects the interactive dialog frame and compares its source document. Its execution remains pending. The 34 generated source documents ship in a separate dependency PR to keep source reviews within the 50-file limit.


## October 7 gallery and widget direction

The new direction keeps the reference's useful structure: a soft blue/pink desktop backdrop, centered translucent Gallery / Tools / Widgets navigation, and generous four-column cards with names and icons above the actual app interface. The Matrix palette and local Instrument typography keep it original. Gallery cards now show an actual 390px app viewport, cropped for the thumbnail; opening the app still offers its full interactive phone preview. One- and two-column layouts adapt at phone and tablet widths. All 17 comparison entries and their current/previous source documents remain available.

The Widgets tab is an interactive, fictional board with Weather, Agenda, Clock, Spending, Focus, Notes, Tasks and Reading designs. Add/remove and explicit keyboard-accessible move buttons update a finite eight-widget state. Personal/Work filters retain hidden widgets; moving within a filter swaps visible neighbors while keeping hidden slots. Adding returns focus to Add widget; removing focuses a visible neighbor or Add widget when the view is empty; moving focuses the moved card even at a disabled-control boundary. Notes, checkboxes and the focus timer work in memory. Reload discards them. This does not install production shell widgets, connect feeds or save owner records.

Artwork is decoration: `public/matrix-app-objects-v1.png` is an original generated transparent 4×2 object sheet, shown with CSS positions without image modification; `public/weather-coast-demo-v1.png` is an original generated coastal illustration. Neither is an app screenshot, an actual destination photo nor evidence of live weather. Actual app previews still come from the integrity-checked source documents. Release assets need their own performance/native qualification.

Both artworks were generated on October 7, 2026 with the built-in `image_gen` tool, as new generations without reference images. Actual PNG dimensions and file sizes were read from their headers/files: object sheet **1774×887, 1,307,642 bytes**; coast illustration **1672×941, 2,573,016 bytes**. The original tool outputs are copied unchanged. The generation prompts were:

**Coast illustration** (`transparent_background=false`):

> Use case: stylized-concept. Asset type: original scenic landscape illustration for a premium Matrix desktop weather widget demo. Create a quiet, sophisticated coastal view: pale blue sky with one soft cloud, cobalt-blue sea, a small sunlit cream seaside town on a green rocky headland, distant mountains. Soft atmospheric light, painterly editorial illustration with realistic depth and subtle grain, sophisticated blue/ivory/pale green colors. Wide horizontal composition, uncluttered upper third for white weather text added by UI later, interesting coastline in lower half. This is fictional decorative scenery, no recognizable city landmarks. No text, numbers, logos, people, interface, frames or watermarks. Must feel richly illustrated and inviting, not generic flat vector stock art.

**App object sheet** (`transparent_background=true`):

> Use case: stylized-concept. Asset type: one transparent sprite-sheet artwork for a premium Matrix App Gallery, exactly four columns and two rows of evenly spaced objects on a transparent background, each object perfectly centered in its own equal rectangular cell. Render eight original tactile 3D app symbols with soft studio shadows, glossy ceramic and colored glass, consistent upper-left light, restrained pastel jewel tones, no square tiles or backgrounds around the objects. Row1 left to right: a folded ivory receipt with embossed small teal coin; a blue-green miniature globe; a coral calendar with blank white paper and no numbers; two amber curved arrows forming a circle. Row2 left to right: a violet glass hourglass; an open ivory book with light blue pages; three staggered green ceramic project tiles; a golden coin with a small embossed rising bar symbol. Front three-quarter product-render perspective, friendly and sculptural, visually distinct silhouettes and consistent size within their cells. Exact 4x2 grid. Fully transparent background between and behind objects. No text, letters, numbers, logos, frames or watermarks.

Run the additional checks from the repository root:

```sh
node --test specs/550-app-store-launch/design-prototype/checks/*.test.mjs
pnpm exec vitest run --root "$PWD/specs/550-app-store-launch/design-prototype" --config "$PWD/specs/550-app-store-launch/design-prototype/checks/vitest.config.ts"
pnpm exec tsc -p specs/550-app-store-launch/design-prototype/tsconfig.json
pnpm exec vite build "$PWD/specs/550-app-store-launch/design-prototype" --config "$PWD/specs/550-app-store-launch/design-prototype/vite.config.ts"
```

The interaction suite uses jsdom with the app-preview component mocked; it verifies navigation, collection/search callbacks and actual widget-card state. It does not prove rendered app frames, CSS overflow, CSP enforcement or Native Mobile behavior. The dependency-free suite separately verifies real source-document integrity. Current browser and Matrix Expo checks remain pending: gallery browser access was denied, and no alternate browser/network/screenshot route was used to bypass that denial.
