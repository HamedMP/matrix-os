# App Gallery: complete launch journey

This is the product journey reviewed on October 7, 2026. The clickable walkthrough is available at `?journey=apps` in the design preview. It uses fictional records, no OAuth, no installation and no owner data. Source app previews are actual compiled interfaces; surrounding store and Chat interactions are simulations.

The design is ready to review. A complete App Store launch is not yet qualified: parent CI failures, remaining exact-head reviews, physical Native Mobile checks, ratings and structured Chat flows still gate release. This document records the intended UX and its implementation boundaries; it does not claim these proposed surfaces are shipped.

## Where users find it

| Surface | Entry and return path | Current evidence / required change |
| --- | --- | --- |
| Public website | Landing page app collection → Apps → detail → Try preview / Get in Matrix | Draft site gallery, app pages and source previews exist. Sign-in/computer-selection resume needs end-to-end qualification. |
| Web Desktop | Launcher → App Gallery; optionally pinned launcher shortcut | App Gallery is an installed first-party app discovered through inventory. Prominent shortcut placement is proposed; do not silently pin to an owner's customized desktop. |
| Electron Desktop | The same launcher and App Gallery window | Shared app bridge/install paths exist. Qualify external consent, discovery and Open with the exact release. |
| Web Canvas | Launcher → App Gallery window; open an installed app in another window | Preserve the same catalog and actions in the spatial presentation. Placement and runtime flow require qualification. |
| Web Mobile | Apps → Explore apps → full-height details | Proposed prominent Explore entry. Back returns to the chosen listing and filters. |
| Native Mobile | Apps → Explore apps → native navigation around the actual app WebView | Narrow bridge work exists in separate drafts; complete installed-app, import, persistence, recovery and device qualification remain required. |
| Onboarding / Connections | Connect tools → recommendations; skip remains available | OAuth/inventory exists. Automatic recommendation handoff and selected-listing resume need wiring/qualification. |
| Chat | Contextual app card → same details/install/open flow | Rich cards below are proposed. Avoid a second catalog, installer or recommendation authority in Chat. |

## 1. Browse before connecting

The public collection shows benefit, original icon, actual release screenshots and source preview, supported tools, Free and truthful ratings. Personal and Business are discovery collections. A signed-out visitor can browse without a computer.

The detail page offers **Try phone layout** and **Get in Matrix**. After sign-in, choose an existing computer or finish provisioning. Preserve listing ID and return intent. A public page never chooses a target computer or mailbox silently.

## 2. Connect useful tools

Choose Gmail, Calendar or another actually supported tool. The secure consent flow returns to the initiating screen. Reconcile authoritative account inventory; a redirect alone is not success.

Show each verified account identity and optional Personal / Work label. Labels are filters, not owner or organization changes. Keep connection IDs immutable. Connecting recommends apps; it does not start reading messages or importing records.

Skip, cancelled consent, reconnect and inventory failure preserve the selected listing. Unknown source discovery is **We couldn't check your tools**, not **Connect Gmail** for an account that may already exist.

## 3. Recommend apps with a reason

Use shared supported-action and account-readiness derivation. With Gmail, propose Folio and Subscriptions; Atlas can start from booking confirmations and optionally add Calendar plans. With Calendar, Agenda fits. Focus remains useful without a connection.

Show a reason beside each app: **Works with your Gmail**, **Calendar adds plans**, or **No connection needed**. No source content is read just to recommend an app. Prefer opening an installed app over repeatedly promoting installation.

The polished recommendation screen is proposed; readiness/filtering exists in draft implementation.

## 4. Preview, review permissions, install

Details use the exact catalog identity and listed release. Show desktop and phone interfaces, main task, supported tools, publisher, version and truthful rating count.

**Install** reviews target computer and narrow app access. An installed customized copy shows **Open** and retains source/data. Installed app storage starts empty; preview fixtures are never copied into owner storage.

States: Install → Installing → verifying authoritative inventory → Open. An uncertain response becomes **Checking installation**, not a second blind installation. Failure preserves the listing and computer selection; incomplete publication is recovered without removing owner edits.

The Linux installer and validated Open path are built in draft code. The permission/target review shown in the walkthrough is proposed UI.

## 5. Choose data inside the app

Folio defaults to the last three months. Atlas defaults to the full 2026 year. Choose exact Gmail/Calendar connection IDs; never default silently to a mailbox. Personal/Work filters are independent of owner scope.

Show selected accounts, date range, source-read scope and expected output before the user requests processing. Dispatch means **Import requested**. Show saved result counts only after operation completion is confirmed. Keep partial results, source evidence, deduplication and owner corrections; retry only remaining reads.

Folio extracts provider, amount, currency, category and evidence. Unknown financial values remain unknown and totals keep currencies separate. Atlas extracts destination, dates, flight details and evidence; a calendar plan is not a confirmed booking.

These app source paths exist, but real selected-account imports and save/reopen need release qualification in all supported OS views.

## 6. Offer an app naturally in Chat

Example user: **Can you organize my receipts and show where my money goes?**

Matrix responds with the short reason and a Folio card:
- Icon, name and benefit.
- Actual preview of the same release used by Gallery.
- **Preview app** / **Open** when installed.
- **Install** uses the same computer and permission flow.
- **Customize Folio** or **Build something different** is secondary.

Avoid building a duplicate app when a reviewed app already fits. An explicit different need opens an editable build brief: purpose, inputs, core screens, owner scope, integrations/read permissions, mobile behavior and design direction. Building does not grant source access. Present a real built preview before declaring an app usable, and retain the brief if compilation fails.

These rich Chat cards and build-brief events are proposed. Reuse catalog IDs and the existing authorized kernel build path; do not encode executable app commands or arbitrary filesystem paths in assistant text.

## 7. Add data through a conversation

For a complete request such as **Add €42.90 at Corner Café to my Work expenses in Folio**, execute the authorized typed save and return a receipt after the server confirms success. Do not add a redundant permission prompt for an already explicit request.

If target app, amount/currency, date or Personal/Work classification is ambiguous, show an editable draft with the destination and missing choices. The walkthrough demonstrates this review card and a failed-save retry. Example fields: Provider, EUR amount, category and Work / Personal. Source is **Chat**, with a link to the originating conversation.

The confirmed receipt says **Saved to Folio**, provider, amount and scope, and offers **Open record**. Open resolves the real app/record identity. The app shows the same database record; it is not a second copy in a separate Chat store. Failed saves retain the draft and never show a success receipt.

Suggested event contracts:
- recommendation: trusted listing ID, release ID, supported-source reason and installed state;
- build brief: bounded editable requirements and declared source permissions;
- data draft: operation ID, target computer/app, schema-valid fields and required missing choices;
- data receipt: operation ID, confirmed record ID, revision and safe display summary.

All IDs are server-derived or verified. Deduplicate retries per operation ID. Reconcile uncertain saves before retry. Enforce owner authorization and schema validation at the server; use transactions for related writes and conditional revision updates for corrections. Notify the open app only after persistence succeeds. No tokens, arbitrary launch paths or raw provider errors reach cards.

Structured production Chat events/actions are not implemented by this design walkthrough. The legacy app_data tool description is not proof that all modern schema-backed records can be changed from Chat; the launch implementation must reuse the authenticated owner Postgres path.

## 8. Return across devices

The installed app appears in **Your apps** and launcher inventory. Chat receipts link to a record, Gallery changes Install to Open, and the desktop icon retains its distinct app identity.

Native Mobile loads the real installed app, uses the authorized short-lived app session, restores navigation and confirmed state, and revalidates cached content. Bound cache by owner/computer/app/release; clear privileged cached state on logout/runtime switch. Cached data may appear while reconnecting, clearly marked when stale. Offline save must not pretend a queued write is confirmed.

Optional notifications ask for channel/timing and use existing Matrix notification delivery with a validated app/record deep link. Sensitive financial details stay off a lock screen by default. A visual widget preview is not evidence of real native background refresh or delivery.

Ratings are optional after verified installation. Selection is a draft; **Save rating** persists one owner/listing vote and aggregate atomically. Change/remove preserve confirmed state until the server succeeds. Production eligibility/persistence remains launch work.

## Release gates before promoting apps

1. Clear actionable review findings and reach Greptile 5/5 on each current PR head. Passing review is separate from CI.
2. Resolve parent CI failures. The mobile CI log currently fails to resolve image-generation.js from the shared contracts entry point; it is not a successful native qualification.
3. Build the complete release stack, then qualify a reviewed test computer. Verify install, exact account selection, bounded import, edit/save/reopen, partial recovery and app launch.
4. Verify Web Canvas, Web Desktop, Electron Desktop, Web Mobile and a real Native Mobile dev client/package. Record exact app/gateway/client versions and release screenshot provenance.
5. Wire and test the structured Chat recommendation/data-receipt flows and promised star ratings.
6. Promote only apps that pass these gates. Preserve customized owner installations and data. Review a scoped rollout before changing customer runtime versions.

The walkthrough and supporting tests are review aids. They do not authorize production rollout, prove native storage/caching, or establish that a queued import completed.
