# Matrix App Store design exploration

A React/TypeScript design review artifact for spec 550. Opens the premium/minimal storefront selected as a direction on October 6; earlier A–C explorations remain available for comparison. It has actual starter screenshots and eight actual starter phone demos, all with fictional records.

**This does not connect accounts, install apps, import owner information or submit ratings.** Connection, account-label, permission and rating steps are explicitly example interactions held in memory. Reload resets them. The production OAuth, store routes, install receipts/ratings, bespoke app releases and Native Mobile host remain work in the launch plan.

## Run

Use the repository's Node 24 and pinned pnpm setup; no additional dependency installation or lockfile is needed beyond `pnpm install --frozen-lockfile` at the repository root. From this directory:

```sh
pnpm exec vite --host 127.0.0.1 --port 3036
pnpm exec tsc -p tsconfig.json
pnpm exec vite build
node public/demos/verify.mjs
node checks/check-ui.mjs
node checks/check-demos.mjs
```

The browser check uses the existing Playwright dependency and a separately launched headless Google Chrome profile. It never attaches to the user's browser. `PREVIEW_ORIGIN` can point it at another locally running preview. Browser launch and local-server access must be permitted by the execution environment. The check closes every context and browser in `finally`.

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
