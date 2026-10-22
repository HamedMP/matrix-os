---
status: active
---
# Preserve owner artwork during the icon refresh

Review found existing owner icon URLs were overridden by bundled defaults, and changed manifest icon stems could disconnect retained custom artwork.

## U9 — Review fixes (one worker)
Goal: keep owner artwork authoritative while supplying sculpted defaults on fresh homes and uncustomized game upgrades.
Files: packages/contracts/src/os-view.ts; tests/contracts/os-view-sculpted-icons.test.ts; home/apps/app-gallery/{matrix.json,src/App.tsx}; home/apps/resource-manager/matrix.json; home/system/icons/{app-gallery.png,resource-manager.png,app-gallery-v2.png,resource-manager-v2.png}; distro/customer-vps/host-bin/matrix-sync-bundled-home-assets; new focused tests/platform/bundled-icon-upgrade.test.ts; specs/362-default-app-sculpted-family/core-icon-prompts.json; preview/mobile.html.
Approach: tests first. Explicit app.iconUrl takes precedence; bundled artwork is the missing-art fallback. Keep App Gallery/Resource Manager stable manifest stems and replace template defaults only; existing protected home icon bytes remain untouched. When a bundled manifest changes icon stems, retain the previous manifest if its currently selected artwork differs from the known bundled legacy asset or cannot be safely classified. Unchanged legacy artwork can adopt the unique game icon. Never overwrite or follow symlinks to owner artwork. Repeated sync remains idempotent.
Additional safe fixes: correct Matrix OS product naming; add UTF-8 to phone review fixture.
Test scenarios: customized Browser and Terminal; unchanged/default/customized/unknown/symlink legacy game artwork; repeated sync; stable utility stems; no owner data replacement.
Verification: root runs focused red/green, relevant template-sync regressions, Gallery/Electron builds. One worker owns all fixes; no concurrent browser testing or other edits in these paths.
