---
title: App Store onboarding and first-use experience
status: draft
created: 2026-10-06
---

# App Store onboarding UX

Draft UX contract for [spec.md](spec.md) and the draft [implementation plan](plan.md). This is not an active execution plan or a claim of shipped functionality. Design prototypes identify fictional connections and example records.

Browsing, connecting, previewing, installing and importing are separate choices. Explain the app before asking for access, verify each account before labeling it, and show the exact sources before requesting an import. Keep skip/manual-use paths available.

Target eight free, reviewed first-party apps: Folio, Atlas, Agenda, Subscriptions, Focus, Meeting Briefs, Projects and Revenue. Publish at least five only after each passes the complete design, data and five-view launch gates. The wider 24-app library remains a roadmap. Unfinished apps are unlisted; the store never fills gaps with fictional install statistics, reviews or ratings.

## Entry and return intent

People can enter from first-run onboarding, the App Store launcher, a recommendation, a public listing/phone-preview link, or an installed app's empty state. The store always exposes **Browse apps** and **Connect tools**. First-run setup offers **Skip for now** without reducing access to discovery or previews.

When a listing opens a connection flow, retain its stable listing/release identity, originating view and pending intent. For example, connecting Calendar from Atlas returns to Atlas details with its updated source state, rather than dropping the owner on the store home screen. Sign-in and computer provisioning preserve that same intent. Validate the resumed listing against the current published release; a removed or incompatible listing shows an explanation and a route back to browsing.

Return intent contains no credentials, source content or executable destination URL. Owner-specific choices remain scoped to the signed-in owner and selected computer. Switching owners clears private selections; switching computers rechecks installation, permissions and source availability before continuing. A stale callback cannot start an install or import on the new computer.

Back returns to the previous store/detail/setup step and keeps non-sensitive drafts. Closing consent or pressing Back never implies successful connection, installation or import. If a durable operation has already started, navigating away leaves its truthful status available in the installed app; returning does not submit it again.

## Flow storyboard

| Scene | What the owner sees and chooses | Primary action and exit |
| --- | --- | --- |
| 1. Choose tools | Supported tools, the useful read actions each enables, and a short explanation that recommendations use connection metadata only | **Connect Gmail**; **Browse apps** / **Skip for now** |
| 2. Confirm identity | External consent, then an in-Matrix verification state. After authoritative verification, show the connected identity and optional label/designation | **Continue**; **Connect another account** / **Not now** for labeling |
| 3. Discover a fit | Up to eight stable suggestions with a concrete source reason, plus Personal, Business and Your apps navigation | **Explore Folio**; **All apps** / **Manage connections** |
| 4. Inspect and try | Benefit, actual desktop/phone screenshots, source requirements, permissions, release/publisher and isolated interactive preview | **Install app**; **Try phone preview** / **Back to apps** |
| 5. Install and select sources | Selected computer and permissions confirmation; completed installation opens an intentional empty app. Exact account checkboxes and Personal/Work filters appear in import setup | **Install on this computer**, then **Review import**; **Start with my own entries** |
| 6. Request a bounded import | Source identities, actions and date range; explicit confirmation, durable progress, coverage and retry states | **Import selected sources**; **Change accounts** / **Not now** |
| 7. Use and optionally rate | Real saved records or the app's manual primary action; source evidence and editing. Rating is available after confirmed installation | App-specific primary action; **Rate this app** / **Maybe later** |

### 1. Connect a tool, then label the verified account

The tool picker distinguishes **Supported**, **Connected**, **Reconnect needed** and **Coming soon**. Only supported, currently approved actions appear as available. Pipedream's provider catalog and arbitrary Custom MCP discovery do not establish App Store support. Explain the value in familiar terms: Gmail can search and read selected messages for an explicitly requested import; Calendar can read selected events. No recommendation needs to inspect messages or events.

Consent opens through the existing trusted external OAuth path. On return, use **Checking your connection…** while reconciling authoritative inventory and approved actions. Completion requires an immutable connection ID with verified active status, including an existing account's reconnect/status transition. A browser close, deep link or newly allocated pending ID is insufficient.

Only then offer account labeling. Show the verified service and available account identity first, with **What should we call this account?** and optional **Personal**, **Work**, or **Unassigned** designation. Example labels are suggestions, never assertions about which account was authorized. **Not now** retains a readable verified account without forcing a designation. If email metadata is unavailable, show **Email unavailable** with the service and a safe distinguishable connection reference; do not invent an email or assume identity from the typed label. Ambiguous accounts need explicit selection before importing.

Labels and Personal/Work designations can be edited later. They are presentation/filtering metadata attached to the immutable connection ID, not identity or an organization permission grant. Personal and Business collections likewise do not change record ownership. Renaming an account cannot silently redirect an existing import to another connection.

Example copy, with fictional identities used only in design evidence:

> Gmail connected: alex@example.com
>
> What should we call this account?
>
> Name: Personal Gmail · Use for: Personal
>
> This name helps you choose accounts. It does not change who can access your data.

Cancellation keeps existing connections and returns to the selected app. A timeout offers **Check connection again** and **Back to app**; it does not report failure as proof that consent was revoked. A failed check uses **We couldn't check this connection. Try again.** and preserves the previous known snapshot as stale, rather than showing it as newly missing.

### 2. Recommend from verified metadata

One shared deterministic derivation ranks apps with all required source/actions ready, then apps needing one tool, then the wider collection, using the reviewed editorial order to break ties. Apps needing no connection remain visible. Required and optional sources come from the release contract; an unavailable optional source does not block the useful primary flow.

Every recommendation states its reason: **Works with your Gmail**, **Uses your Calendar and Gmail**, **Connect Stripe for Revenue**, or **No connection needed**. Readiness uses active account metadata and authoritative approved-action availability. It is not inferred from a tool logo, OAuth success page or installed state. A refreshed snapshot updates reasons together; cards do not jump while individual requests settle. Installed apps lead to **Open app** in Your apps instead of repeatedly competing for discovery attention.

For example, verified Gmail makes Folio and Subscriptions relevant; verified Calendar adds Agenda and improves the relevant Atlas/Meeting Briefs source paths. Focus remains useful with neither. These examples describe supported release requirements, not a promise that every connected tool has a finished app.

### 3. Show the actual app and a real phone preview

Cards show the app's identity, one benefit, a screenshot from the listed implemented release, relevant tools, and **Install app** or **Open app**. Details expand the signature task, required/optional sources, permission summary, publisher **Matrix**, release version, desktop/phone screenshots and aggregate rating state. Screenshot captions say **Example records**. Phone screenshots show the actual phone composition, not a desktop screenshot scaled down.

Offer **Desktop** and **Phone** layout controls plus **Try preview**. On a computer, **Preview on your phone** opens a copyable public link and QR code. On a phone, it opens the interactive phone composition directly. Keep **Example preview · Changes reset on reload** visible, with **Back to app details** and **Install app** outside the example application's data surface. A preview must support a meaningful app-specific action, such as inspecting a receipt, switching Atlas map/list, or starting a Focus timer.

Preview uses the exact published release UI and a dedicated fictional-data adapter. It requires no account, computer, connection or installation. It does not carry Matrix cookies or bearer credentials, receive the owner bridge, read/write owner records, call providers/kernel tools, or follow arbitrary external navigation. Its reviewed demo origin/context serves allowlisted immutable assets under restrictive network/CSP policy. Native preview cookie sharing is disabled. The public URL identifies listing/release only; never encode an owner, account, runtime launch token or personal record. Temporary demo edits never become installed records.

If the preview cannot load, retain screenshots/details and offer **Retry preview**. If that exact release is unavailable, explain **This preview is unavailable** rather than swapping to an unrelated release. Back and close return to the same listing. A public preview remains public even if the visitor is already signed in; it never upgrades itself into an authenticated installed-app frame.

### 4. Install into the chosen computer

Installation confirmation names the destination computer and reviewed release. Multiple computers require an explicit target choice; a single current computer can be clearly shown. Sign-in or provisioning resumes the same listing afterward. Do not silently target a different computer because a background selection changed.

The permission summary describes actual declared capabilities in plain language: **Stores records in this app on your computer**, **Reads only accounts you select when you request an import**, and **Does not change your source tools** where those statements match the release. Explain that installation is free and a requested Matrix-assisted import may use ordinary Matrix AI usage. Source account selection and processing consent are separate from installation; installation alone reads no source content.

Use **Installing…** only while publication is in progress. **Installed · Open app** requires a complete usable registered app, not a queued request or downloaded archive. On an uncertain response, **Check installation** reconciles before repeating work. Retrying is idempotent. Existing customized apps are opened without replacement; incomplete folders receive **Installation needs attention** with a safe recovery explanation, not a destructive overwrite prompt.

A completed local install can be usable while its platform receipt is pending. Show **Installed** truthfully, keep **Open app** available, and explain rating eligibility separately as **Confirming installation for ratings…**. Receipt-delivery retry must not reinstall the app. Unverified legacy/customized installations stay usable and never fabricate store counts or rating eligibility.

### 5. Choose exact sources and review the import

The empty app offers its app-specific action: **Import receipts** for Folio, **Import journeys** for Atlas, **Add an entry**, or **Start a focus session**. Include **Set up later**; do not seed preview fixtures into the owner's new app.

Group source choices by service. Each selectable row shows the verified identity, editable display label, Personal/Work/Unassigned designation and connection state. Multiple accounts are explicit independent checkboxes, including multiple Personal accounts. No mailbox is selected silently. Source selection stores immutable connection IDs and the label/email snapshot used for binding; labels alone are never the account selector.

Personal/Work selection controls how imported records are classified and filtered inside the owner's app. It does not move data into an organization. Distinguish these choices visually from the store's Personal/Business collections. Missing required source actions explain the affected feature; manual entry remains available when the app supports it. Unknown source availability offers retry, not a misleading **Connect** prompt for an already known account.

The review step lists exact selected accounts, source actions, date range and destination. Folio defaults to the last three calendar months; Atlas defaults to the full current year. Display concrete resolved dates before submission and preserve the owner's changes. Optional sources are visibly optional. Bounded ranges and coverage limits come from the implementation contract; the UI does not offer **All time** unless that bounded source path is supported.

Example confirmation for an owner-chosen range, using fictional account labels:

> Import receipts into Folio
>
> Read selected Gmail accounts: Personal Gmail and Work Gmail.
>
> Range: 1 July–30 September 2026.
>
> Matrix will read matching source messages, keep evidence and save records in Folio. It will not send messages or change Gmail. Your existing corrections will be kept.

Use **Import selected sources** as the explicit processing action. If accounts, identity snapshots, permissions or runtime selection change before or during processing, stop future reads and ask for reselection. Review changed selections again rather than silently retrying against a replacement account.

### 6. Report progress, partial coverage and retries honestly

After confirmed dispatch, show **Import requested** and a durable operation reference. **Queued**, **Reading selected sources**, **Saving records** and **Finished** appear only when backed by operation state. A spinner alone is not progress; no invented percent or guessed completion time. Show actual processed counts where the backend provides them, otherwise use the truthful phase and last update.

Keep navigation usable. Background/foreground and network reconnection recover the same operation and saved records; they never create a duplicate import. A supported **Stop import** action stops future work best-effort and explains that already saved records remain. Do not offer cancellation until the service has an observable cancellation contract. Closing a screen is not cancellation.

Completion names actual writes and coverage: records added/updated, selected range, skipped items, source caps, and uncertain facts. A capped or partially failed run says **Import partly completed** with usable results retained. **Retry remaining sources** reuses the operation/deduplication contract after checking the exact account bindings. Transport ambiguity first offers **Check import status**. Lost access offers **Reconnect and review accounts**. Errors never expose raw provider messages or filesystem paths.

Owner edits survive import and retry. A conflicting save keeps the draft and offers deliberate comparison/reload; it does not replace the draft with a background server response. Unknown amounts remain unknown, currencies remain separate, and source evidence is inspectable. **Finished** must not imply that every source item was covered when caps or failures occurred.

### 7. Reach first use, then offer a rating

After setup, land on the useful app view rather than an onboarding-success screen. Folio opens its real receipts/spending view; Atlas opens actual saved journeys or a useful manual-plan state; Focus can begin immediately. A first use may be manual and does not require importing or rating. Records save/reopen in owner storage across all five OS views.

Offer **Rate this app** in details and Your apps only after the platform confirms installation eligibility. A quiet optional invitation after the first useful action is acceptable; **Maybe later** preserves uninterrupted use. Do not gate use, imports, previews or support behind feedback.

The rating control is an accessible one-to-five-star radio group with labels such as **4 stars** and an explicit **Save rating** button. Selection is a draft, not submission. Show the owner's saved vote separately from the public decimal average/count. **Change rating** and **Remove my rating** are available; writes/removal settle before replacing the confirmed state. If saving fails, keep the draft and prior vote with **Your rating wasn't saved. Try again.** Anonymous visitors see aggregate ratings plus **Install to rate**.

Use **No ratings yet** for zero votes. A real average always includes its sample count. Do not seed a sample rating, silently submit on install, award stars for importing successfully, or show fabricated popularity/install metrics. A server eligibility failure refreshes eligibility and explains the next action without falsely clearing an already confirmed vote.

## Shared state and copy table

| State | User-facing presentation | Available action / retained context |
| --- | --- | --- |
| No connections, verified empty inventory | **No tools connected yet**; manual apps and public previews remain visible | Connect tools, browse, skip |
| Inventory/action discovery pending | **Checking your tools…**; previous results stay visibly provisional | Browse; preserve selected listing |
| Inventory/action discovery unavailable | **We couldn't check your tools**; readiness is unknown | Retry; browse/preview; no automatic source request |
| Required tool missing | **Connect Calendar for this feature** | Connect with return-to-app intent; manual use where supported |
| Account expired/revoked | **Reconnect Personal Gmail** | Reconnect; verified status transition, then review exact selection |
| Account active, required action unsupported | **This connection doesn't support the source action this app needs** | Inspect supported sources; manual use; no false ready badge |
| All required sources/actions ready | **Sources available**; readiness is separate from consent | Install/open; choose exact accounts before import |
| Multiple matching accounts | **Choose accounts in the app** | Explicit selections; never default to a mailbox |
| Optional source absent | Explain the optional feature it adds | Connect optionally; continue primary flow |
| Install request in flight | **Installing…** on the chosen computer | Prevent duplicate submission; browse without losing status |
| Install response uncertain | **Checking installation…** | Reconcile; preserve listing/computer; retry only after status check |
| Complete app, receipt pending | **Installed** plus **Confirming installation for ratings…** | Open/use; retry receipt confirmation independently |
| Existing customized app | **Already on your computer** | Open unchanged; no implicit update or replacement |
| Incomplete publication | **Installation needs attention** | Safe recovery/retry; preserve owner files |
| Import request accepted | **Import requested** / confirmed phase | Recover operation status; no completion claim |
| Import cap/partial failure | **Import partly completed** with actual coverage | Use saved results; retry remaining sources where supported |
| Account binding changed | **Review your accounts before continuing** | Retain records/range; reselect and confirm |
| Save conflict | **This record changed while you were editing** | Keep draft; deliberate compare/reload choice |
| No confirmed rating receipt | **Install to rate** or pending-confirmation explanation | Preview/use as appropriate; no client-forged eligibility |
| Rating write/removal failed | Safe failure message; prior saved vote retained | Retry; keep draft; do not alter displayed confirmed aggregate locally |

## Behavior in all five OS views

| OS view | Presentation and navigation | Required equivalent behavior |
| --- | --- | --- |
| Web Canvas | Store/details/installed apps in spatial app windows; explicit target computer | Same account choices, actions and saved records; resized windows retain drafts and useful layouts |
| Web Desktop | Store navigation, detail overlay/page and app windows | Complete connection → install → import → use → rate journey; keyboard operation and focus return |
| Electron Desktop | Shared feature UI with native chrome and trusted networking | Same journey; external consent, validated installed-app launch, runtime-generation guards and isolated preview context |
| Web Mobile | Compact collection navigation and full-height detail/setup screens | Open launches the actual installed app stack; Back restores the listing; source selection/forms/records remain usable with keyboard |
| Native Mobile | Native navigation around the actual responsive app WebView | Real authenticated MatrixOS capability bridge for installed apps; isolated public preview mode; reliable session recovery and save/reopen |

Use the same recommendation/readiness, permission, exact-account and rating derivations in all views. Chrome may differ; no primary action or error state disappears. A Native Mobile **not supported** notice is not an accepted launch substitute. The draft requires new narrow native host capabilities; current app-session loading alone does not provide them.

On phones, use a compact collection row and readable connection summary, full-screen details with a reachable install action, and stepwise account/range/review setup. Keep the selected identity visible while confirming. Long names/email labels wrap without hiding the account distinction; selected account state is announced to assistive technology. Show source evidence and editing in sheets/pages that preserve Back navigation. Charts expose labeled values and an accessible list/table alternative; necessary horizontal comparison has deliberate labeled scrolling.

Verify 360, 390, 600, 820, 1024 and 1440 CSS pixels, intermediate app windows, landscape, safe areas, large text and color modes. Touch targets are at least 44×44 pixels. The keyboard never hides Save/Continue, and unsaved notes/selections survive resize and background/foreground. Reduced motion preserves meaning without animation. Preview maps/timers and app gestures must not trap browser/native Back navigation.

Installed frames use only the narrow declared owner/runtime/frame-bound capabilities, with trusted native networking and server authorization. Logout, runtime switches and frame replacement invalidate pending work and discard stale responses without losing confirmed owner records. Expired app sessions offer a bounded retry and inline recovery; they do not sign out the entire native account. Public demo frames never inherit these privileges.

## UX evidence required before listing an app

For each promoted hero, capture its actual listed release with fictional desktop and phone records; retain provenance linking screenshots, demo assets and install package. Demonstrate one useful signature task, its intentional empty state, exact-source selection where relevant, bounded import/result states, edit/save/reopen and optional rating. Verify the same journey in Web Canvas, Web Desktop, Electron Desktop, Web Mobile and a built Expo dev client or packaged Native Mobile client; record exact client/gateway/app versions.

Exercise skip, browse, Back, cancelled consent, reconnect, two Personal accounts plus a Work account, unknown discovery, missing actions, computer switch, uncertain install response, partial import, preserved manual edits, save conflict and failed rating submission. Prove public preview origin/cookie/network isolation through the real host. The design prototype and browser screenshots are review aids, not evidence of authenticated native persistence or launch readiness.

Measure coarse listing/release funnel outcomes only: verified connect, recommendations shown, details/preview, confirmed install, first useful action and repeat use. No account emails, labels, OAuth credentials or source records enter analytics. Include a separate public documentation PR describing this journey and its real limitations before release.
