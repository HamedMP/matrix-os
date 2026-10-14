# Browser VPS comparison results

Dates: 2026-10-12–13. Status: live validation in progress; no production rollout.

## Environment

An owner-only disposable Matrix preview VPS runs native host services on Ubuntu 24.04 x86_64 (2 CPU, 4 GB RAM). Its collaborator list is empty. Chrome's dedicated profile is outside the synced Matrix home. The primary runtime has no lab services installed.

Verified tools: agent-browser 0.39.0, Browser Use 0.13.11, KasmVNC 1.5.0, Google Chrome 155.0.8059.39. The official 1Password extension is installed. No real vault has been unlocked by the agent.

## Observed comparison

These are actual tool runs against the synthetic fixture, using deterministic browser actions rather than an AI planner. The human action in this first comparison was submitted through the fixture API; it does not establish that viewer mouse/keyboard forwarding works.

| Check | agent-browser | Browser Use actor |
|---|---|---|
| Fake password sign-in and generated TOTP | passed | passed |
| Automation takeover after two actions | 91 ms | 88 ms |
| Automation actions during 2.5-second human window | 0 | 0 |
| Resume after one simulated human action | continued from 3/10 | continued from 3/10 |
| Final acknowledged work count | 10/10 | 10/10 |
| Same Chrome instance after takeover/resume | yes | yes |

The supervisor terminates automation and confirms its input gate before enabling human input. Resume starts fresh observation from the fixture checkpoint. This is checkpoint continuation, not a promise that arbitrary external side effects can be replayed exactly once.

## Native Browser Use AI pause

A bounded Haiku 4.5 trial used temporary owner-approved developer model access before personal authentication. The final diagnostic run passed fake password sign-in and the generated code, but ended before any work action: 10 model steps, `done(success=False)`, three history errors classified as schema failures. The requested mid-work pause checkpoint was never reached. Native `Agent.pause()` / `resume()` reliability therefore remains **unverified**.

Earlier trials also ended without a mid-work checkpoint. One harness defect was corrected: after restarting the supervisor, the synthetic page must reload to avoid retaining the old generation's completed UI. Model and page logs were suppressed. Only bounded synthetic counts, booleans and error categories were recorded. The temporary key was removed after every run; no key remains in the Matrix home or trial runtime directory.

## Security and integration evidence

- Browser CDP, supervisor and KasmVNC listen only on loopback.
- Unauthenticated direct viewer HTTP and WebSocket upgrades both return 401.
- The gateway stores its viewer credential server-side. The client receives a one-use viewer ticket with a 60-second admission deadline.
- Generic apps retain the opaque iframe sandbox. Browser Lab's Web Canvas/Web Desktop controls are compiled into Matrix; mutable owner HTML receives no additional iframe privileges.
- The lab installer preserves the runtime environment file's ownership and mode. Preview snapshots missing the public shell origin receive the exact Matrix origin for CSRF/WebSocket validation.

## Profile and WebAuthn checks

A synthetic localStorage marker survived browser-level `Browser.close()` followed by Chrome service restart. The original service restart lost that marker, so the installer now requests graceful Chrome shutdown and waits for its service process to exit before the bounded systemd fallback. Six focused helper tests pass. After applying the updated service configuration, the same marker survived a normal Chrome service restart on the test VPS; the marker was then removed. This is not yet evidence that real service cookies or an unlocked password-manager vault persist correctly.

An isolated-world virtual WebAuthn authenticator completed create and get ceremonies with the same credential. This validates only synthetic browser WebAuthn plumbing. It does not test 1Password passkeys, real security keys, Touch ID, or server verification of the assertion.

## Live viewer and takeover checks

After the provider incident, the owner-approved scoped restart restored the test runtime. The registered preview bundle `v2026.10.13-pr2526-38405824284-1-da4afdf` was installed and verified with the core and browser services active. No release channel was promoted.

| Surface | Observed result |
|---|---|
| Web Canvas | live Chrome preview, actual pointer input, typed fake credentials and generated TOTP, and one manual fixture action passed |
| Web Desktop | full Chrome preview and actual pointer/keyboard forwarding passed; agent-browser takeover acknowledged at 6/10 and resumed to 10/10 |
| Web Desktop with Browser Use actor | takeover acknowledged at 2/10; the streamed human click advanced to 3/10; explicit Resume completed 10/10 |
| Electron Desktop, trusted Browser surface | shared compiled viewer streams Chrome; actual pointer input and the full `matrix-lab-native` keyboard marker reached remote Chrome |
| Electron Desktop, standalone Browser Lab app | the separate packaged test build streams Chrome and forwards actual pointer/keyboard input (`matrix-lab-standalone`); the installed desktop app still needs the corresponding release |

The original standalone Electron failure occurred at platform WebSocket principal resolution: per-app route/session cookies did not establish a platform principal. The native fix supplies a bearer only from the trusted main process for the live Browser Lab view’s exact installed Kasm iframe WebSocket, with matching origin, auth generation and one valid-format viewer ticket. HTTP and other apps/paths/frames are excluded; closing the view or changing runtimes revokes registration. No general platform admission or app sandbox rule changed. The separate packaged app used an isolated temporary desktop profile; the installed application was not replaced. Live streaming and an unsubmitted keyboard marker passed.

The original fit issue clipped Chrome inside the viewer. Both lab clients now use KasmVNC scale mode, retaining the remote resolution while fitting the full browser into the viewer. Web and Electron marker typing was verified visibly and was not submitted as a search. The initial Canvas focus click selects the Matrix window; subsequent clicks interact with Chrome.

The viewer connection has a ten-minute maximum session duration. Reconnect preview restored streaming after expiry during testing; automatic renewal and a clearer disconnected state are not implemented. Reloaded tool selection can also display agent-browser while the supervisor owns a Browser Use run; this display discrepancy does not change which existing run Resume continues.

The official 1Password extension welcome screen is open in the shared browser with human control enabled. Real owner authentication remains pending:

| Check | Status |
|---|---|
| Real 1Password vault/password/TOTP | owner reported signing into 1Password; real autofill/TOTP testing is reserved for the owner |
| 1Password passkey ceremony | awaiting owner participation |
| Local Touch ID / security-key forwarding | unverified; generic remote desktop is insufficient |
| Profile persistence across Chrome service restart | synthetic marker passed with the graceful-stop fix; real service cookies/vault state remain unverified |

## Review and documentation

Implementation: [Matrix PR #2526](https://github.com/HamedMP/matrix-os/pull/2526). Required separate public documentation deliverable: [site PR #234](https://github.com/FinnaAI/matrix-os-site/pull/234). The docs page was rendered at 375, 768 and 1440 px with no document-level horizontal overflow.

Focused gateway/supervisor/installer/transport tests and CLI VM-prefix regressions passed. The compiled viewer adds ten behavioral tests; 95 existing app/bridge/session regressions passed. Shell and gateway typechecks passed. Native diagnostic privacy checks passed separately. The latest native-asset authorization and viewer-fit increment passed 42 focused gateway/UI tests and the gateway typecheck. Native launch token exchange, trusted GET/HEAD asset admission, replay rejection and denied unrelated requests are covered. The standalone viewer fix passed 81 focused native transport/embed/view tests, the full desktop typecheck and production desktop build, followed by the separate packaged-app preview/input check.

The test VPS remains disposable with a 72-hour preview lifetime. Retention/deletion will be confirmed with the owner after the authentication checks. Preserve unfinished worktrees and the primary checkout; neither PR has been merged.

## Chrome-first app delivery — 2026-10-13

The comparison UI is now separate from two product apps: **Browser** and **Cloud desktop**. Browser opens full Chrome in a larger responsive Matrix window; the remote display resizes to the active presentation. Cloud desktop reveals the same Linux workspace with Show desktop, Files, Terminal and Open Chrome. Both canonical identities are available in Web Canvas, Web Desktop and the new Electron test build.

The registered host preview `v2026.10.13-pr2526-38451269733-1-327ddd8` is installed only on the owner-only disposable VPS. Chrome's service process remained unchanged throughout the upgrade. Existing Files and Terminal processes also survived supervisor restart. The primary runtime, customer fleet and release-channel pointers were not changed.

| Current Chrome-first live check | Result |
|---|---|
| Web Canvas launcher and fitted Browser | passed |
| Web Canvas actual pointer/keyboard input | passed; unsubmitted public marker visible in Chrome |
| Web Canvas Matrix minimize → dock restore | passed; same unsubmitted marker retained |
| Linux Chrome minimize → Restore Chrome | passed; clear recovery state restores the existing window |
| Web Desktop launcher with Browser and Cloud desktop | passed |
| Web Desktop Matrix minimize → launcher restore | passed; same unsubmitted marker retained |
| Cloud desktop Show desktop, Files and Terminal | passed; native Linux apps restore and accept real input |
| Cloud desktop Open Chrome | passed; Browser connected while Cloud desktop became paused |
| Browser explicit reconnect | passed; connected state recovered |
| New Electron app identities/minimize/restore | passed in the isolated packaged test build after owner unlock |

Nineteen actual screenshots are annotated in [the Figma review board](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1970-64). They show public pages, unsubmitted synthetic input, the native Linux desktop, blank Terminal and public wallpaper files. They contain no vault pages or credentials. Historical Electron diagnostic evidence above is separate from these new Chrome-first checks.

After the owner unlocked the Mac, the isolated packaged Electron Desktop passed its actual launcher, real keyboard input, Matrix minimize → launcher restore, full-window/tab sizing, native Chrome minimize → Restore Chrome, explicit reconnect, Cloud desktop Show desktop/Files/Terminal, and Open Chrome. The unsubmitted `matrix-chrome-electron` marker remained visible after restore. No app replacement, Chrome restart or real account transaction was performed.

The stable changed-feature run passed **34 files / 441 tests**, including real loopback viewer transport. Gateway, shared UI, shell and Electron typechecks passed; production shell, hosted-app, Electron build and isolated packaging passed. Structured review covered twelve perspectives and resolved six validated findings; targeted re-review was clear. A broad local run encountered unrelated restricted-environment failures and is not claimed as green.

Native Chrome metadata differed from the initial fixture: the live window class includes its fixed profile path, and Chrome exposes a bounded collapsed process title. The helper now recognizes those exact owned formats while rejecting foreign executables, profiles and duplicate arguments. The installed Kasm client also required a self-contained connection bridge; the product Connected state now follows the actual viewer transport.

The new apps renew their owner session independently and suspend streaming when inactive or minimized. Product views share one exclusive stream; reconnect requires a fresh claim. These statements supersede the earlier diagnostic viewer's fit and renewal limitations. Agentic Chat controls, physical passkey forwarding, music/audio, location proxies and laptop extension access remain deferred.

## Electron session-expiry fix and workflow skills — 2026-10-13

A long-session test found that Electron renewal rejected a valid owner app cookie when the authenticated gateway saw internal HTTP behind its HTTPS proxy. The native installer now derives Secure from the trusted HTTPS transport while retaining the exact app/path, signed owner session, HttpOnly, Strict same-site, bounded lifetime and current-authentication checks. Two regressions use the gateway's actual cookie builder and signing/verifying functions through native bridge admission for both product identities. Both failed before the fix and pass afterward.

The isolated packaged Electron Browser remained open beyond the actual ten-minute cookie expiry, showed Disconnected, and recovered through one Reconnect action. The renewed native cookie was Secure/HttpOnly/Strict with a fresh bounded expiry. The same Chrome service process remained running, and all eight scoped core/browser services were active. Cloud desktop connected afterward, resized to a full tab, showed Linux, and returned to the existing Chrome. These checks did not restart Chrome or inspect personal credentials.

The Figma board now includes nineteen new actual evidence cards: ten Web checks, seven packaged Electron checks, and the real expiry/reconnect pair. An actual rendered reconnect card was checked for clipping, overlap and screenshot distortion.

The earlier disposable test VPS installed the three unprefixed preparation drafts and its owner-authenticated skills catalog returned them enabled. The current release pack ships `matrix-browser-admin`, `matrix-accounting-preparation`, and `matrix-information-collection` from `skills/matrix/` through the normal skill sync path; the sync and loader tests pass, while live catalog verification of these renamed skills remains pending. Independent synthetic accounting evaluation detected duplicates/conflicts, reported incomplete coverage and missing originals, preserved source provenance, and ignored a payment instruction embedded in source data.

Current capability remains precise: agent-browser and Browser Use CLI actors can attach to the lab Chrome. Chat's existing Matrix browser uses separate Chromium; these skills do not create a shared Chrome bridge or add downloads, native dialogs, WebMCP or physical passkey forwarding. Real password-manager, TOTP and passkey checks remain owner-led; Browser Use's native model-driven pause/resume remains unverified.

A twelve-perspective review of the narrow renewal fix reported no introduced actionable finding. It noted an overlapping auth-generation cleanup race in cookie installation, tracked in [#2570](https://github.com/HamedMP/matrix-os/issues/2570). The current Electron layer serializes cookie installation and stale cleanup; a deferred old-write/new-login regression passed after reproducing the race red.

Final verification: **37 files / 495 tests** passed in the bounded Browser/reconnect/skill scope; the template manifest (**8**) and existing browser-tool contracts (**37**) passed separately, for **39 files / 540 tests**. Desktop typecheck, production build and isolated packaging passed for the renewal fix. Shared Chrome orchestration is tracked in [#2571](https://github.com/HamedMP/matrix-os/issues/2571).
