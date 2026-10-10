# Refreshing Gallery screenshots

This runnable fixture ships in the final Gallery stack layer (#2406), after the
catalog, Gallery, connected starter and shared sign-in components exist. Use
that complete stack checkout; the planning layer (#2387) does not provide it.

The fixture renders the actual connected-starter components with four fictional
datasets (`folio`, `atlas`, `projects`, `cashflow`) and 27 empty workspaces.
It never reads an owner's database or connects integrations. Installation is
deliberately unavailable here; verify it on the disposable preview computer.

From the repository root, with Node 24 and locked dependencies installed:

```sh
pnpm exec vite --config specs/362-default-app-sculpted-family/preview/vite.config.ts
```

While the fixture is running, run `node specs/362-default-app-sculpted-family/preview/capture.mjs`.
It captures every app at **1738 × 2033 CSS pixels**, device scale 1, light mode,
after fonts and images load, and fails on horizontal overflow. Inspect a sample
of the resulting screenshots before committing. Keep `src/preview-screenshots.ts`
accurate: only the four IDs above are `example`; all other captures are `empty`.
If Playwright's bundled Chromium is unavailable locally, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a trusted installed Chrome binary.

After refreshing, build Gallery and inspect `?app=gallery`: open app details and
verify screenshot identity and its Example data / Empty workspace label. Check
`http://127.0.0.1:3052/mobile.html` for the 390px list and details layout. These
checks validate presentation; they do not prove hosted installation works.

Preview build and capture tooling resolves Tailwind CSS/PostCSS and Playwright through `shell/package.json`, where those dependencies are declared. It does not require root dependency hoisting.
