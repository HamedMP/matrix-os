# Refreshing Gallery screenshots

The fixture renders the actual connected-starter components with four fictional
datasets (`folio`, `atlas`, `projects`, `cashflow`) and 27 empty workspaces.
It never reads an owner's database or connects integrations. Installation is
deliberately unavailable here; verify it on the disposable preview computer.

From the repository root, with Node 24 and locked dependencies installed:

```sh
pnpm exec vite --config specs/362-default-app-sculpted-family/preview/vite.config.ts
```

For every ID in `home/system/app-gallery.json`, open
`http://127.0.0.1:3052/?app=<id>` in the browser at **1738 × 2033 CSS pixels**, with
device scale 1 and browser zoom 100%. Capture the viewport, not the full document.
Before capture, verify the expected app heading and primary view are visible,
loading has finished, and there are no unresolved images or horizontal overflow.
Use the same locale and light theme across the collection. The fixture's dates
are fixed; the Focus timer should remain idle at 25:00.

Save the PNG to `home/apps/app-gallery/src/assets/previews/<id>.png`. If the browser
captures JPEG, convert only the raster format to PNG; do not alter content or
invent UI. Keep `src/preview-screenshots.ts` accurate: only the four IDs above are
`example`; all other captures are `empty`. Check all 31 files before committing.

After refreshing, build Gallery and inspect `?app=gallery`: open app details and
verify screenshot identity and its Example data / Empty workspace label. Check
`http://127.0.0.1:3052/mobile.html` for the 390px list and details layout. These
checks validate presentation; they do not prove hosted installation works.
