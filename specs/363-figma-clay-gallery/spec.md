---
status: active
---
# Figma clay icons and Apps gallery

Use Desktop-app nodes 1742:156 (icon rules), 1734:5767 (Apps), and 1741:107 (detail) as the visual source of truth. Retain the existing catalog, owner data boundaries, install/open/retry orchestration, account readiness and collection filters. Share the packaged Gallery across Web Canvas, Web Desktop and Electron Desktop; adapt to Web Mobile and Native Mobile frames with safe areas and touch targets.

## U1 — Artwork
Files: Gallery artwork resolver and local icon assets, default icon assets, icon-generation instructions and focused artwork tests.
Use the exact nine clay assets supplied by Figma for their matching semantic identities. Preserve owner-provided artwork. Keep all assets local and validate file integrity and packaged paths. Extend the same documented palette, raised object and light recipe to remaining icons without assigning the same generic game controller to every game. Test-first for resolver changes; existing invariant coverage for pure asset replacements.

## U2 — Detail
Files: new GalleryDetail.tsx and GalleryDetail.css; focused detail tests.
Build the full content page: back navigation, large identity, action, metadata strip, real app previews, Access/connection information and truthful manual-entry/permission state. No invented permissions or imports. Retain installation errors, pending states and account labels. Test-first for navigation and action wiring.

## U3 — Gallery and integration
Files: App.tsx, App.css, GalleryResults.tsx, build-composer helper and associated tests.
Replace dark editorial shelves with the Figma warm-white, 1080px content layout: Apps/search heading, build composer, Your apps strip, category tabs, compact three-column preview cards and build Ideas. Build suggestions must invoke the actual Matrix chat bridge; gracefully disable unavailable capabilities. Preserve collection/readiness controls without dominating the layout. Test-first for build handoff and gallery/detail state.

## Verification and shipping
Run relevant Gallery/model/race/artwork checks, production Gallery and Electron Desktop builds. Inspect Web Desktop, Web Canvas, Web Mobile and actual Electron Desktop; qualify Native Mobile separately before advertising readiness. Ship a follow-up PR based on the reviewed Gallery stack, without modifying the stable desktop or deploying production. Add a separate FinnaAI/matrix-os-site content/docs PR explaining Apps, installed strip, building and detail access. No new endpoints or database writes; auth remains the existing Matrix bridge/gateway owner scope.
