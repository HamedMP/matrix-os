# Apps and Matrix App Gallery release readiness

This guide defines the communication and evidence gates for an Apps release. It is not an App Review approval or a declaration that the gallery is available.

## Product vocabulary

- **Apps**: installed experiences in an owner's Matrix workspace. Generated Matrix apps are web apps, not separately installed iOS binaries.
- **Matrix App Gallery**: curated discovery. Use this exact name in product copy when that surface ships. Do not label Matrix discovery App Store or AppGallery.
- **Templates**: starting projects copied into an owner's app instance.
- **Connect Apps**: connected-account setup and supported actions. OAuth authorization to Matrix is separate from an individual app's permission to read an account.
- **Tools**: bounded agent actions. The term does not change the execution or permission model.
- Refer to actual presentations: Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile.

Apps creation starts a conversation in Chat. A creation button must not promise that an app is already installed, qualified or ready to use. Keep the owner's installed list distinct from a curated catalog.

## Evidence before making claims

Record the exact gateway bundle, app package/catalog revisions, client build, OTA channel/runtime, relevant flags and enabled storefronts. A merge, passing unit tests, a prototype screenshot or an older TestFlight build does not establish release availability.

| Claim | Evidence required |
|---|---|
| Create and use an app | Discovery/request → Chat → confirmation → owner instance → open → edit/save → close/reopen. Confirm data survives on every advertised presentation. |
| Curated discovery | Production list/search/details; accurate screenshots, provenance, permissions and account requirements; creation/install reaches a real owner instance. |
| Works on iPhone | Exact signed Native Mobile build on a physical device. Database/service bridge, account switching, session expiry and recovery must work for the advertised app. |
| Connected-account app | Real authorize/read/deny/revoke with the selected account, bounded fields and per-app consent. A simulated preview is not live OAuth evidence. |
| Public listing | Explicit opt-in preview, attribution/rights consent, sanitized metadata/screenshots, edit and withdrawal including caches. Private apps stay private by default. |
| Community execution | Enforced isolation and reviewed package/version identity, not a trust label or sandbox stub; abuse reporting, response, blocking and withdrawal. |
| Paid creator app | Software controls plus approved payment/entitlement/refund/restore design and settled creator terms. |
| Offline or app notifications | Actual app behavior after disconnect/restart and real delivery. Cache/query configuration or push registration alone is insufficient. |

At the initial naming audit, Native Mobile could list/open runtime apps but did not inject the workspace data bridge used by generated apps on Web Desktop. Treat apps needing that bridge as unqualified on Native Mobile until the corresponding implementation and physical-device evidence land. A notice explaining the limitation is not a substitute for functionality.

The October launch plan targets eight qualified starters with a minimum of five. That is a Matrix launch gate, not an Apple requirement. If the production gallery is not qualified, describe the website as a curated showcase and distinguish it from in-product discovery and Native Mobile availability.

## First release scope

Keep the initial executable catalog to reviewed free first-party starters and qualified private owner apps. Do not imply that a metadata showcase enables arbitrary executable community distribution.

Treat public listing, community execution, paid creators and general native mini-app capabilities as separate release decisions. Main registry endpoints and install counters are not proof of a reviewed, owner-authorized distribution workflow.

For each supported app:

1. Identify package/version, owner instance and declared capabilities.
2. Display purpose, selected account, data fields and persistence before data access.
3. Make denial/revocation work without silently discarding edits.
4. Enforce permissions on the server, scope data by owner/app instance, and keep secrets out of app code.
5. Confirm app creation, saving and exports across the advertised presentations.
6. Verify safe loading, empty, error, disabled and recovery states.
7. Define a content/age classification and appropriate report/block/withdrawal operations.

## Native submission gates

- Sign in with Apple and other enabled sign-in paths work for first-time and returning accounts, cancellation and account linking.
- In-app deletion is easy to find and reaches complete account/data cleanup, with timing, legal retention and billing handling disclosed. Verify Apple token revocation where applicable.
- Production deletion flags/dependencies are active; a simulator using an in-memory service does not prove them.
- Review access has a funded computer, sanitized examples and no purchase or operator-assisted OTP requirement. Use a separate disposable account for destructive deletion testing.
- The hosted software index, metadata and universal links are qualified. A custom URL scheme is not a universal link. Resolve private dynamically generated indexing with Apple without exposing private code or data.
- Age restrictions, privacy disclosures and per-software consent match the actual features.
- Review notes accurately describe downloaded HTML/JavaScript executing in WebKit, server-side agents/builds/database, and the exact bridge exposed to app code.
- Inventory Expo OTA updates and keep updates within reviewed functionality. Do not activate hidden marketplace or payment features after review.
- Freeze real screenshots from Native Mobile; do not use Web Desktop or design-prototype evidence as an iPhone screenshot.

Apple's [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) and [Developer Program License Agreement](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/) govern the actual architecture. In particular, assess software-host rules, native API exposure, consent, index/links, moderation/age, payments and minimum utility. Renaming is not a policy exemption.

## Purchase navigation and offer truth

Choose a consumer commerce implementation or an assessed companion-app configuration before release. A hosted VPS or a business-themed starter does not by itself establish a payment exception.

Audit every reachable purchase path: native onboarding/billing, Chat links, generated web-app links, same-origin routes, redirects, popups, account/help portals and custom schemes. The native external-purchase helper does not automatically govern WebView or Chat navigation.

Native app-preview navigation containment is one boundary. It is not a content sandbox or a complete audit of arbitrary generated HTML, scripts, resource requests or payment copy. Keep supported informational, consent, privacy and deletion flows available through reviewed host surfaces.

- Use storefront eligibility, signed entitlements and appropriate APIs for any regional payment feature.
- Review current [EU payment guidance](https://developer.apple.com/support/payment-options-on-the-app-store-in-the-eu/) (unified terms effective October 1, 2026), [Japan guidance](https://developer.apple.com/support/payment-options-on-the-app-store-in-japan/) and [StoreKit external-purchase APIs](https://developer.apple.com/documentation/storekit/external-purchase). Do not apply one region's permission globally or reuse outdated EU economics.
- Separate purchased AI credits, promotional grants and subscription allowances. Verify expiry/refund/revocation/restore semantics for the chosen commerce model.
- Reconcile public trial duration, starter credit, eligibility, funding caps, renewal charges, cancellation and exhausted-credit states with actual production configuration before filming or publication.
- At the audit, code defaults were a three-day card trial and a $5 funded campaign; the proposed seven-day/$10 launch offer needed explicit configuration and qualification. Do not change marketing to the proposal until those gates pass.
- Keep referral rewards separate from first-release claims until economics, fraud prevention, consent and storefront policy are qualified. Do not incentivize store ratings or TestFlight participation.

## Review notes and go/no-go record

A submission packet should state:

- exact client/build and backend/catalog revisions;
- actual features and limits on each presentation;
- where source builds, agents and data live and where web JavaScript executes;
- allowed software types, permissions, index/links, age and moderation controls;
- selected payment configuration and storefront restrictions;
- review-account steps, save/reopen and deny/revoke tests, deletion test account;
- privacy/support/deletion URLs and the timing of cleanup.

A video supplements a working review environment. It does not replace it. Do not claim approval or App Store availability until the actual submission is approved and available.

Use existing ownership: ENG-89 for Native Mobile readiness; ENG-96/ENG-161 for app lifecycle/builder qualification; ENG-157 for curated production discovery; ENG-158 for opt-in listings; ENG-162 under ENG-91 for connected accounts; ENG-75 for technical go/no-go; GTM-514/515 for claims and offer; GTM-520/527 for qualified showcase evidence. Keep open login, deletion and gallery PRs as dependencies rather than duplicating them.

The release owner records pass/fail evidence and any explicit presentation limitation. A website launch, Native Mobile submission and approved Native Mobile availability are separate milestones.

