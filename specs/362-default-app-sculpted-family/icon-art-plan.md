---
status: active
---
# U8 — Gallery icon artwork in the Matrix brand
Goal: distinct meaningful sculpted artwork for all first-party gallery apps, following existing default-app family and Figma brand moodboard.
Files (asset worker ownership only): home/apps/app-gallery/public/icons/*.png; specs/362-default-app-sculpted-family/icon-prompts.json. No code/manifests/SVGs/other icon directories.
Approach: read catalog and canonical identity colors; generate one separate asset per unique app id with the built-in imagegen skill, using tactile glazed ceramic, matte clay, frosted glass, nature-led forest/sage/clay/amber/pearl materials; simple central recognizable semantic subject, neutral ivory tile, generous space. Distinct silhouettes. Figma moodboard xPG2FeYRtC9owCKSVXCqWA1:545 and /private/tmp/matrix-brand-moodboard.png. Existing reference home/system/icons/notes.png and files.png. Avoid ornate gold everywhere, abstract circuitry, repeated game controllers and indistinguishable mini dashboards.
Execution note: no behavior changes, artwork inspection/asset inventory validation rather than tests duplicating pixels. Use imagegen (one call per distinct asset; no contact sheet substitute). Save project assets in assigned public directory. Use sips for256px PNG output optimization; preserve originals in generator output. Record prompt per app. Do not stage/commit/run project suites.
Patterns: semantic existing sculpted defaults, packages/brand/src/app-identities.json, canonical catalog metadata.
Test scenarios: every catalog id has nonempty distinct image, same family and varying intentional app colors, recognizable at64px.
Verification: root visually reviews artwork and validates PNG/readable app identifiers; gallery renders PNG by app id with SVG fallback.
Parallel safety: this asset directory and prompt JSON are disjoint from root core assets, U5 presentation and U6 backend.
