# Browser product identity and publishing

Tracking: [ENG-332](https://linear.app/matrix-os/issue/ENG-332). Follow-up to merged Browser product delivery #2829; viewer recovery #2879 and CDP lifecycle #2943 retain their own scope.

## User outcome

Browser and Cloud desktop are OS products. Their running/restored dock entries must retain distinct canonical artwork, and neither may expose Publish app. Ordinary owner apps retain publishing and explicitly selected artwork.

## Observed boundary and proposed behavior

- Electron routes both products through the fixed browser-lab application, distinguished by appIdentity. A nonempty route slug alone is insufficient publication eligibility: recognize these OS product identities before rendering publication controls or reading publication state.
- Electron cold-restored product tabs may omit explicit artwork. Resolve their canonical built-in path through existing browser-product and bundled-artwork helpers. Preserve explicit custom artwork and existing ordinary-tab fallback.
- Web Canvas and Web Desktop already render these canonical products through RemoteBrowserView before the owner-app publication wrapper. Retain that path, including supported historical aliases; assert absence of owner publication fetches/actions rather than adding another product renderer.
- Current source includes these products in dock logic. Component regression demonstrates missing specialized artwork after restore, not categorical absence of running controls. The user's complete missing-icon observation remains a live exact-version acceptance case.

## Acceptance matrix

| Starting state / action | Observable completion | Boundary / lane |
|---|---|---|
| Electron Desktop opens either product in desktop/tab, desktop/window or canvas/window | No Publish app action or publication-state request | Actual DesktopSurfaceFrame/component regression |
| Electron Desktop opens an ordinary owner app | Publishing remains available | Existing Notes regression |
| Both product tabs restore without explicit icon | Distinct canonical image plus running indicator | Actual Taskbar and production artwork helper |
| Product is minimized, restored or closed | Running control persists while open and disappears when closed; explicit icon remains selected | Product state regression |
| Web Canvas/Web Desktop opens canonical product or supported Browser alias | Shared remote product, no owner-app wrapper/publication request | Existing presentation regression |
| Exact signed Electron, Web Desktop and Web Canvas on an approved runtime | Correct visible dock artwork, focus/minimize/restore and no publishing UI | Pending actual runtime/screenshots; component checks do not substitute |

## Invariants and delivery

No new endpoint, authorization, network destination, profile store, artwork family or launcher catalog. Reuse canonical identity and existing bundled assets. No VNC/Computer Use change. Public documentation is delivered separately through the existing matrix-os-site Browser guide PR #288. Keep review/CI separate from exact-build live acceptance; no deployment or merge is authorized by this spec.
