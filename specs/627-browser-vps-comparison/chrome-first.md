# Chrome-first Matrix app

Status: complete for the scoped Chrome-first preview. Long-session Electron reconnect was fixed and verified after actual ten-minute expiry on 2026-10-13. Merge and customer rollout remain subject to PR review.

Implementation status (2026-10-13): C1–C4 are implemented and the exact registered preview is installed only on the disposable test VPS. Web Canvas, Web Desktop and the isolated packaged Electron Desktop passed launch, real input, Matrix minimize/restore, Linux Chrome recovery, Cloud desktop actions and explicit reconnect. Nineteen actual screenshots are on the Figma board, including expired and recovered Electron states. Public documentation is updated in site PR #234. The installed desktop application was not replaced.

Design: https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1949-6334

## Scope

Browser (`__browser__`) opens the existing owner VPS Chrome with full tabs/extensions/native dialogs. Cloud desktop (`__cloud-desktop__`) exposes the same Linux workspace with Files and Terminal launch actions. No agent selection, fixture counters, password capture, music, proxy, or laptop-extension UI in these apps. The diagnostic Browser Lab remains available separately. Chrome and its private profile survive presentation close/minimize/restore.

Browser and Cloud desktop share one display. Exactly one product viewer owns input and remote resizing at a time; activating another product view revokes the previous stream. Inactive/minimized views suspend streaming and reacquire on activation. Unavailable services show a clear retry state, never silently open an external browser. Preserve unrelated Electron BrowserTab navigation and localhost tunnels.

## Units

### C1 — Owner-scoped Linux window service and exclusive live viewer
- Goal: restore/maximize the same Chrome window, show Linux desktop, open Files/Terminal, and accurately signal viewer connectivity.
- Files: scripts/spikes/browser-vps/supervisor.mjs, new native-window helper(s), install.sh, packages/gateway/src/browser-lab/*.ts; focused tests/gateway/browser-lab* and tests/spikes/browser-vps*.
- Approach: fixed executable/actions; bounded X11 metadata (WM_CLASS/PID/state only), verify process belongs to owner and Chrome service/profile, never read titles/DOM. Preserve existing diagnostic API. New API contract below. Product stream claim revokes older product streams/tickets; diagnostics cannot bypass exclusivity. Inject narrowly scoped installed-client bridge for connected/disconnected messages, no page data.
- Execution note: tests first, show failing tests before implementation.
- Tests: owned minimized Chrome restores/maximizes; missing Chrome fails safely; foreign PID/class is rejected; command timeout; show desktop/files/terminal; status excludes titles/paths; control body/auth/origin/strict schema; competing viewer invalidation; late/expired ticket rejected; shutdown drain; bridge origin/source; no profile restart.
- Verification: focused tests and live test VPS without restarting Chrome.

### C2 — Shared Browser / Cloud desktop UI
- Goal: one polished feature component/controller for Web and native hosted app.
- Files: packages/ui/src/browser/**, packages/ui/src/index.ts; shell/src/components/RemoteBrowserView.tsx (new adapter); scripts/spikes/browser-vps/lab/src/main.tsx/style.css (retain fixture/diagnostic); focused tests/ui/browser*.
- Approach: BrowserSurface props `{ gatewayUrl, surface: 'browser'|'desktop', active?, ensureSession(signal): Promise<void> }`; feature-scoped CSS with token adapters. Thin toolbar Restore Chrome / Cloud desktop navigation callback optional / Reconnect. Desktop has Show desktop / Files / Terminal / Open Chrome. True connection messages validate event.origin, event.source, bounded payload; fail closed and provide explicit reconnect. iframe fills remaining height, resize=remote, no min-height/letterboxing. Session/controller teardown on runtime/active changes; no auto-restart loop.
- Execution note: tests first, show failures before implementation.
- Tests: session-before-claim, fixed origin/prefix URLs, active lifecycle, late responses ignored, pointer gated by acknowledged human+stream state, restore failure retry, minimized recovery, stream expiry and explicit reconnect, malicious postMessage rejected, no fixture/tool controls in product surface.
- Verification: shared UI tests, lab build, shell build.

### C3 — Native launcher and app admission
- Goal: Browser/Cloud desktop destinations open distinct reusable native surfaces with full Chrome, preserve generic browser tabs.
- Files: desktop renderer launcher/tab/persistence/EmbedHost modules and corresponding tests; desktop/src/main/embeds/embed-service.ts + focused helper if needed, viewer admission tests.
- Approach: app tabs routeSlug browser-lab with appIdentity matrix-browser or matrix-cloud-desktop. Main maps only these fixed identities to surface=browser|desktop query on the existing trusted launch URL; launch middleware preserves query. Include appIdentity in app tab dedup and durable canonical path mapping. Generic browser kind/localhost behavior unchanged. Active-state change communicates visibility to raw product app through narrow same-origin bridge; native reload re-registers viewer admission for current auth generation. Cloud desktop adds launcher/icon fallback. No arbitrary query/navigation API.
- Execution note: tests first, show failures before implementation.
- Tests: launcher opens correct reusable identities; two views distinct; minimize/reactivate uses same tab; close/reopen not Chrome restart; persistence alias canonical path; exact URL query allowlist; unrelated app/browser unaffected; reauth admission refresh scope.
- Verification: native renderer/main focused tests, typecheck and production desktop build.

### C4 — Web launcher, parity and delivery (orchestrator)
- Goal: route Browser and Cloud desktop to trusted compiled shared UI in Web Canvas/Web Desktop; persist canonical identities and restore on launch/focus. Integrate all units, deploy exact scoped preview, validate actual UI and update Figma evidence and public docs PR.
- Files: contracts/os-view catalog/exports, shell launcher/builtin paths/window rendering/window sizing and focused tests; specs/results; separate matrix-os-site browser docs PR.
- Execution note: tests first for behavior; styling follows approved design.
- Tests: launcher no external Google, same canonical identity after reopen/minimize, app bridge parity, Canvas/Desktop active and minimized lifecycle, unavailable service error, bounded responsive launch geometry.
- Verification: focused cross-surface tests, typechecks/builds; Web Canvas → Web Desktop → packaged Electron Desktop live checks on existing test VPS. No primary runtime/fleet/channel changes. All PR review findings handled before merge.

## API / auth

All product APIs remain under `/apps/browser-lab/api/`, use the existing owner-signed browser-lab app session and the optional installed service gate. No new credential exposure.

| Route | Auth | Purpose |
|---|---|---|
| GET browser-status | signed owner app session | coarse availability, Chrome present/minimized, humanControlAvailable |
| POST browser-control | same + allowed Origin + bodyLimit | `{action:'restore-chrome'|'show-desktop'|'open-files'|'open-terminal'}` |
| POST browser-session | same + allowed Origin + bodyLimit | `{surface:'browser'|'desktop'}` → short-lived one-use `{ticket,expiresAt}`; exclusive stream claim |
| viewer/websockify | existing one-use ticket + origin admission | bounded authenticated stream, claim expiry and shutdown drain |

Status contract: `{available:boolean, chrome:{present:boolean,minimized:boolean}, humanControlAvailable:boolean}`. Browser-control returns same coarse status after successful action. Generic errors only. Product claims expire with app session; older product/diagnostic streams are revoked on product activation. Stream bridge message: `{type:'matrix-browser-viewer',connected:boolean}` to parent origin only. No DOM/window titles/inputs/screenshots in API or telemetry.

The underlying Chrome profile stays outside synced owner home. Linux apps are installed only on the test VPS for this preview. Future customer provisioning/package promotion is deferred pending review; public docs explain installed-service availability honestly.
