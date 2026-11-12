# PR regression analysis

Tracking: [ENG-349](https://linear.app/matrix-os/issue/ENG-349/improve-engineering-workflows-and-shipping-velocity-from-the-pr-audit).
Audit source: `be6cce1404bfd6db3392c535bca2e0def32ec577`.
History snapshot: 25 October 2026; latest 1,000 PRs returned by `gh pr list --state all --limit 1000`, by creation time.

## Scope and evidence limits

- Exactly **1,000 distinct PRs**, created **21 September–25 October 2026**, numbered 1825–2938. PR numbers are not assumed contiguous.
- **604 merged, 339 open, 57 closed without merge** at the snapshot. Open work and author-reported validation are not evidence of shipped behavior.
- All 1,000 titles, descriptions, dates and states received a reproducible metadata screen. Changed paths were inspected programmatically for all 604 local merge objects. This is a census, not 1,000 complete patch reviews.
- **48 PRs received additional fault-boundary review**: 47 local production diff excerpts and added regression scenario names; the complete supplied patch for the open paste fix #2936. No test executions or original-bug replays were performed by this history workstream.
- Of the 604 merged PRs, **587 exact merge commits are ancestors of the pinned source**. Seventeen merged into integration branches or otherwise lack exact ancestry; equivalent later inclusion is not inferred from the merge flag.
- Six dependency PR descriptions (#2811, #2569, #2541, #2508, #2153, #2034) are exactly 65,536 characters; the ledger records possible incompleteness rather than assuming complete upstream release notes. Reaching this size is not itself proof the API truncated them.
- Filename matching proves neither useful assertions nor current CI execution. Historical claims are attributed to PR descriptions until independently reproduced.

## What the census says

| Classification | PRs | Interpretation |
| --- | ---: | --- |
| `fix` titles | 416 | Includes product, test, CI and dependency changes; not 416 distinct production incidents. |
| Product-fix candidates after excluding CI/test/dependency scopes | 342 | Rule-based triage requiring domain review. |
| Merged product-fix candidates | 242 | Every one changed at least one test file in its local merge diff; 240 exact merge commits are ancestors of the pinned source. |
| Open product-fix candidates | 81 | Include important unfinished fixes; do not count as repaired in `main`. |
| Closed, unmerged product-fix candidates | 19 | May be superseded or abandoned; do not treat closure as resolution. |
| All merged PRs with changed test files | 583 / 604 | More test additions alone would not resolve the quality problem. |

The recurring gap is **whether tests assert the intended outcome across the actual boundary**, including recovery and platform behavior. Many fixes already add extensive tests. Test count, import count, coverage and a large passing batch cannot independently establish that a user journey works.

## Existing work to reuse

- [#2936: web terminal paste](https://github.com/HamedMP/matrix-os/pull/2936), **open**, tracks ENG-392. Paste omitted `terminalRef`; ordinary typing used a different sender. The patch shares the production sender and validates paste frames with `TerminalTabClientFrameSchema`. Reuse this fix and extend acceptance at the real Web surface; do not duplicate its implementation. Its description still lists live surface evidence as pending.
- [#2517: disconnected tests and consolidation](https://github.com/HamedMP/matrix-os/pull/2517), **open**. Its description reports eight disconnected suites/107 cases removed, plus consolidation with net 18 fewer files/113 fewer cases. It links production-coverage comparisons, removal inventories and mutation evidence at `74c9cd6858e6f7c9dcf4f49a78933a1e53813e25`. Review/reuse those actual changes and revalidate against current source. These savings are author-reported scoped benchmarks, not a new full-CI measurement.
- [#2775: real PostgreSQL collaboration qualification](https://github.com/HamedMP/matrix-os/pull/2775), **merged**. This is a useful pattern: required cohort, zero-skip evidence, actual backend and exact-source binding. Preserve it when reducing CI cost.

## Reviewed failure mechanisms and lowest useful protection

These are requirements derived from reviewed source excerpts and descriptions, not declarations that each current journey has passed. Extend an existing owning test before creating another suite.

| PRs | Failure boundary | Useful regression protection |
| --- | --- | --- |
| [#2936](https://github.com/HamedMP/matrix-os/pull/2936) (open) | Paste produced a malformed tab-input DTO that its own tests accepted. | Call the production paste producer, parse its actual output with the production consumer schema, then paste and execute a unique command through the Web UI and real tab. |
| [#2606](https://github.com/HamedMP/matrix-os/pull/2606) | Viewer eviction left transport alive; snapshot/live handoff could lose output. | Real socket lifecycle, expiry and same-tab reconnect; inject numbered output during snapshot read and require exactly-once ordered delivery without replacing the process. |
| [#1875](https://github.com/HamedMP/matrix-os/pull/1875) | A new capability made an older client reject the whole attach frame. | Current server producer against retained older-client schema; capabilities only when negotiated. |
| [#1946](https://github.com/HamedMP/matrix-os/pull/1946), [#1943](https://github.com/HamedMP/matrix-os/pull/1943) | Delayed layout/history replies overrode newer scrolling intent. | Controlled gesture/reply interleavings plus real renderer geometry; distinguish follow-bottom from deliberate pan and disposal. |
| [#1939](https://github.com/HamedMP/matrix-os/pull/1939) | Direct storage mocks hid stream type/length requirements of the production platform broker and S3 SDK. | Real HTTP broker, production storage client and S3-compatible service; compare resulting bytes for declared-length and chunked input. |
| [#2010](https://github.com/HamedMP/matrix-os/pull/2010) | Manifest reader understood direct SDK bodies but not broker-returned web streams. | Multi-chunk mirror startup using actual broker-shaped streams; split UTF-8, over-limit bytes and non-settling cancellation. |
| [#1936](https://github.com/HamedMP/matrix-os/pull/1936) | Restart and publication races could overwrite owner edits/deletions; shutdown wiring missed host termination. | Real owner filesystem and durable baseline across restart/SIGTERM, edits before watcher/CAS, deletion/recreation and deadline expiry. |
| [#2634](https://github.com/HamedMP/matrix-os/pull/2634) | Return from Stripe lost the reserved plan/region/tools, causing an unrecoverable reservation conflict. | Checkout → leave → return/reload → exact resume or provider-confirmed abandonment; inject older refresh after newer state. |
| [#2039](https://github.com/HamedMP/matrix-os/pull/2039) | Slow first readiness probe starved a later healthy model. | Parallel candidate integration with shared deadline, policy revocation, caller disconnect and atomic budget assertions. |
| [#1901](https://github.com/HamedMP/matrix-os/pull/1901), [#1898](https://github.com/HamedMP/matrix-os/pull/1898) | Funding/checkout health was confused with zero credit; unpaid routing could expose JSON instead of recovery UI. | Real funding/routing services plus billing recovery navigation, preserving exact runtime and device-return context. |
| [#2675](https://github.com/HamedMP/matrix-os/pull/2675) | Exceptional starter-credit repair needed protection from replay, duplicate grants and deletion races. | Real PostgreSQL concurrent admission, exclusive journal and exact review hash, expiry after lock wait, no refill on replay. |
| [#2931](https://github.com/HamedMP/matrix-os/pull/2931) | Matrix funding masqueraded as native Claude readiness; small clock skew hid current credit. | Combine native legacy bindings and ready managed credit under skew; retain exact owner source, original expiry and quiet refresh. |
| [#2778](https://github.com/HamedMP/matrix-os/pull/2778) | Saving a key did not reliably select/enable that exact key for the actual adapter. | Connect key through production workflow, observe catalog, then inspect actual child credential environment; late UI completion and rollback cases. |
| [#2832](https://github.com/HamedMP/matrix-os/pull/2832), [#2545](https://github.com/HamedMP/matrix-os/pull/2545) | Saved native login, binding bookkeeping, catalog and launch authority diverged. | Owner-read → exact principal recovery → catalog → real adapter admission; concurrent reads, account drift, logout and uncertain cleanup across restart. |
| [#2659](https://github.com/HamedMP/matrix-os/pull/2659) | Initial bootstrap failure was treated as resumable native state. | Replay exact historical failed checkpoint and explicitly retry through durable thread store/adapter without duplicated input. |
| [#2721](https://github.com/HamedMP/matrix-os/pull/2721), [#2717](https://github.com/HamedMP/matrix-os/pull/2717) | Idle-pool handling missed checked-out Postgres errors and resource ownership. | Realistic client/socket failure during/between queries, transaction rejection without write replay, reconnect and exactly-once owner shutdown. |
| [#2774](https://github.com/HamedMP/matrix-os/pull/2774) | A replaced file/folder could inherit authority from a path/stat identity. | Real physical replacement with comparable metadata, exact descriptor generation, denial before owner reauthorization and revision/descendant fences. |
| [#2680](https://github.com/HamedMP/matrix-os/pull/2680) | Project deletion fences could block its own shared-run/Chat cleanup and recovery. | Shared project with active/archived Chats; fail mid-cleanup, restart, retry same journal and verify immutable identity/authorization. |
| [#2193](https://github.com/HamedMP/matrix-os/pull/2193), [#2165](https://github.com/HamedMP/matrix-os/pull/2165) | Create/move missed inherited sharing or lost model history across execution roots. | Real assignment transaction rollback and actual adapter prompt capture across global → project A → B → global, retry and queued execution. |
| [#2137](https://github.com/HamedMP/matrix-os/pull/2137) | One invalid item or all-invalid page hid valid shared inbox items. | Mixed-validity pagination with cursor progress and valid items beyond dropped pages. |
| [#2708](https://github.com/HamedMP/matrix-os/pull/2708), [#1858](https://github.com/HamedMP/matrix-os/pull/1858) | OAuth method assumptions and session middleware blocked real callbacks. | Mount actual platform route; callback without browser cookie; public/confidential registration, token refresh/revoke, tamper/replay/expiry and older-callback CAS. |
| [#1869](https://github.com/HamedMP/matrix-os/pull/1869) | Individually tested route factories collided when mounted together. | Actual application registration order and consumer contracts for both onboarding and agent-catalog routes. |
| [#1915](https://github.com/HamedMP/matrix-os/pull/1915) | Duplicate labels silently chose an integration account. | Exact owner/account selection; duplicate explicit labels refuse before any provider call. |
| [#2138](https://github.com/HamedMP/matrix-os/pull/2138) | New core migration markers skipped channel schema; replies needed original verified phone authority. | Real deployed schema revisions, channel migration/restart twice and complete signed-phone verification/reply/STOP flow. |
| [#2233](https://github.com/HamedMP/matrix-os/pull/2233) | Drive metadata/JSON paths were mistaken for file content and repeated reads wasted paid calls. | Actual authenticated action dispatch to content reader; export/plain text, restrictions, streamed byte caps and owner-isolated coalescing. |
| [#2674](https://github.com/HamedMP/matrix-os/pull/2674), [#2688](https://github.com/HamedMP/matrix-os/pull/2688) | Supervised approval became a dead end; later turns reset accepted Chat modes. | Tool request → owner approve/decline/expiry → same-run result, then next turn/navigation; preserve unsent draft and exact accepted supported modes. |
| [#2785](https://github.com/HamedMP/matrix-os/pull/2785), [#2788](https://github.com/HamedMP/matrix-os/pull/2788) | Healthy runs hit 30-minute wall time; the repair invented a four-hour owner cap. | Fake-clock adapter/process test beyond both thresholds with ongoing progress; owner inactivity and funded total deadline remain distinct. Expected policy comes from requirements, not the new implementation. |
| [#2782](https://github.com/HamedMP/matrix-os/pull/2782) | Digest mismatch was confused with runtime supersession, preventing safe recovery. | Actual tool loop retains digest refusal then performs explicit path-only workspace read; wrong attachment digest never reveals bytes. |
| [#2494](https://github.com/HamedMP/matrix-os/pull/2494), [#2493](https://github.com/HamedMP/matrix-os/pull/2493) | URL normalization/DNS and streaming/decompression escaped simplistic security/resource tests. | Normalized numeric/hex/IPv6/mixed-DNS denial before network; one total deadline across redirects/body/cancel and decoded byte caps. |
| [#2640](https://github.com/HamedMP/matrix-os/pull/2640), [#2642](https://github.com/HamedMP/matrix-os/pull/2642) | Browser owner handoff could wait behind a download; Electron routing expiry differed from Browser cookie expiry. | Abort/drain before pause/takeover plus built Electron exact-scoped cookie renewal, partial installation and generation races. |
| [#2698](https://github.com/HamedMP/matrix-os/pull/2698) | Undo in a second view used stale permission state. | Revoke from another view; refresh on conflict, preserve uncertain state and ignore late responses after changing Chat. |
| [#2706](https://github.com/HamedMP/matrix-os/pull/2706), [#2249](https://github.com/HamedMP/matrix-os/pull/2249) | Android keyboard/window behavior differed from JS assumptions; native dependency ABI mismatch survived a clean build. | Keep the useful native-symbol compatibility guard; add actual Android picker/keyboard interaction with send visible in direct, agent and project Chats. A web viewport cannot prove this. |
| [#2178](https://github.com/HamedMP/matrix-os/pull/2178), [#2287](https://github.com/HamedMP/matrix-os/pull/2287) | Mobile streams flooded requests; terminal transport still assumed legacy sessions. | Controlled SSE/reconnect plus bounded request counts and current workspace/tab contract; real device grid/keyboard/end-state journey. |
| [#2427](https://github.com/HamedMP/matrix-os/pull/2427), [#2431](https://github.com/HamedMP/matrix-os/pull/2431) | Slack upload metadata encoding and Workers redirect options differed from test assumptions. | Protocol-specific request assertions plus target Workers runtime smoke; retain bytes/retry state and never forward credentials on redirect. |
| [#2020](https://github.com/HamedMP/matrix-os/pull/2020) | Owner-writable update marker needed a narrower authority boundary. | Execute real updater scripts with forged metadata, bad hash and concurrent trigger replacement; only platform-verified immutable metadata reaches extraction. |

## Journey completeness checklist

Use this as a **requirements map**, not a green coverage map. Every row needs an owning test, actual CI selection, supported surface matrix, red/green fault proof and current acceptance evidence. Existence of a test with a matching filename is insufficient.

| Journey | Required outcome and disruptive transitions | Representative history |
| --- | --- | --- |
| Sign in and device approval | Signed-out → authenticate → exact owner/runtime; browser callback, expiry, cancellation and retry; no ambient owner bypass. | #2495, #1858, #2063 |
| First use and trial | New owner → plan/region/tools → checkout → provision → runnable first Chat/app; return/reload and abandoned setup recover. | #2790, #2714, #2634, #2885 |
| Subscription and paid credit | Server-verified checkout/webhook → one entitlement/credit → exact runtime use; duplicate/out-of-order events and failed/ambiguous payment remain safe. | #2634, #1901, #2675 |
| Provision, readiness and delete machine | Actual host services ready before success; failed activation, stale jobs, resize/recovery and cleanup retain owner data and spend bounds. | #2433, #2720, #2020 |
| Choose and connect AI | Saved exact account/model/mode → advertised readiness → actual execution; Off, logout, expired catalog and account change stay consistent. | #2778, #2832, #2931, #2545 |
| Funded execution and settlement | Admission → inference → exact bounded usage → settlement/release; timeout/cancel/unknown outcome never double charges or deadlocks capacity. | #2807, #2440, #2197 |
| Chat send, stream and recovery | User text accepted once → complete assistant output → durable reload; disconnect, partial reply, queue, explicit retry and cancellation preserve truth. | #2105, #2659, #2178 |
| Long-running work | Progress keeps owner runs alive; inactivity and funded deadlines enforce the correct distinct policy. | #2785, #2788 |
| Tool approval and execution mode | Owner sees correct pending request, approves/declines/expires once, execution obeys receipt and accepted modes persist into later turns. | #2674, #2688, #2640 |
| Move, import and reopen Chat | History remains readable and native prompt has exact committed context across projects, imports, retries and refresh. | #2165, #2383, #2380 |
| Create and run Bots | Scratch/template creation → exact model/accounts/grants → real tool call and reply; saved legacy definitions, failed discovery and retry work. | #2873, #2890, #2782, #2594 |
| OAuth and integration account lifecycle | Connect → callback → discover → permitted read/write → token refresh → revoke; no-cookie callbacks, confidential clients and multiple accounts. | #2708, #1858, #1915, #2710 |
| Connected content and drafts | Actual content arrives through the authenticated account; owner grant/confirmation precedes a write, stale grants refuse and failures retain drafts. | #2233, #2684, #2711 |
| Inbox triage and retained mail | Exact mailbox/account/grant → bounded resumable classification → intended label/draft; retries preserve idempotency and revocation stops work. | #1938, #1923, #1914, #2098 |
| Messaging ingress and response | Signed transport → correct owner/company context → runnable agent → reply to verified destination; duplicate events, schema upgrades and STOP. | #2138, #2079, #2124, #2251 |
| Speech and voice | Permission → actual capture → text/audio result → cancellation/reconnect; quotas and deployed speech configuration remain correct. | #2821, #2791, #2713 |
| Terminal input and attachments | Create/open real project tab → focus → type/paste/file attach → command execution in only intended tab; no implicit Enter, byte integrity and denied clipboard recovery. | #2936 (open), #2454, #2038, #2287 |
| Terminal persistence and navigation | Detach/TTL/reconnect same process → restored screen and continuous exactly-once output; resize, scroll, ownership handoff and old/new clients. | #2606, #1875, #1946, #1943 |
| Files and owner sync | Create/read/edit/save/download/export/delete → restart/reconcile; conflict preserves draft/bytes, streamed broker transport and watcher/CAS races. | #1939, #2010, #1936 |
| Shared projects and resources | Invite/accept/open → create/move Chat/file → member access → revoke/archive/delete; physical replacement and partial cleanup cannot extend authority. | #2774, #2193, #2680, #2137 |
| Organizations and account-only access | Select active organization and exact owner runtime; missing/changed membership, no computer and stale directory show truthful recovery. | #2085, #2065, #1827, #1987 |
| Apps and persistent app data | Install/open → bridge read/write → reload/update → export/erase; sandbox and complete app identity retain data and deny foreign grants. | #2355, #2403, #2406, #2405 |
| Build, preview and publish app | Generate source → build → preview → publish exact checked version → visitor submission → unpublish; failed build/navigation/install recovers. | #2041, #2423, #2422, #2385 |
| Shared Browser | Open/renew exact owner session → agent action → permission → owner pause/takeover → resume; cookies, download drain and Undo remain current. | #2640, #2642, #2698, #2687 |
| Presentation and preferences | Switch Web Desktop/Web Canvas, reopen Electron and restore app/window/theme state; controls stay operable under resize/zoom and error overlays. | #2678, #2663, #2420, #2301 |
| Native Mobile and offline recovery | Cold start → auth → Chat/project/terminal → native keyboard/menu → background/offline/reconnect; native dependencies, scoped cache and request load. | #2249, #2706, #2178, #2582 |
| Account deletion | Export/grace period/cancel → confirmed deletion across billing, grants, machines and data; interrupted jobs resume without post-fence writes or duplicate charge. | #2177, #2638, #2675 |
| Release and rollback | Exact built artifact → verified metadata/hash → install only OS paths → healthy services → channel/rollback; custom owner files and running work survive. | #2020, #1936, #2713, #2791 |
| Preview isolation | Exact PR/owner/runtime routes and funded quotas, no production credential/owner leakage; activation and expiry cleanup. | #1926, #1949, #2886, #2896 |
| Security and resource boundaries | Foreign owner, stale grants, normalized private URL, oversized stream, timeout and uncertain write are denied without leaking secrets or bypassing recovery. | #2493, #2494, #2774, #1915 |
| CI qualification itself | Required tests actually execute for the tested source/backend; missing runtime, skipped cohort, stale receipts and superseded runs never claim success. | #2105, #2775, #2784, #2724 |

Planned/open work such as direct Gmail processing, source App Store publishing, Edition and Aoede must add or refine the relevant journey before shipping. Their open PRs are part of the census, not proof these features are available or validated in the pinned source.

## Source capability cross-check

History alone misses older, quiet and hidden capabilities. Independently inspected the root architecture map, gateway route inventory and actual registration modules, CLI command registration/MCP server, organization/account-deletion routes, desktop updater and all **27 default-app manifests**. Twenty-five manifests are apps and two are build templates. The manifest categories are eight productivity, five utility, one finance, eight games, one utilities and two social; category spelling is preserved rather than silently normalized.

The following **18 additional or more explicit journey requirements** extend the 31 history-derived rows. These are source-derived requirements, not assertions that coverage is absent or that every registered endpoint is currently a supported product surface.

| Additional journey | Required outcome/fault boundary | Owning source inspected |
| --- | --- | --- |
| Scheduled actions and proactive heartbeat | Persist once/interval/cron job, restart, fire at intended time/active hours, deliver once to intended channel, delete/stop without a late trigger. Distinguish cron's actual delivery behavior from proactive kernel execution. | `packages/gateway/src/server/home-utility-routes.ts`, `packages/gateway/src/server.ts`, `packages/gateway/src/cron/service.ts`, `packages/gateway/src/heartbeat/runner.ts` |
| Self-healing modules and watchdog | Detect unhealthy module, back up before attempted repair, recheck health, restore on failure and preserve protected owner files; no overlapping repair or runaway repeated invocation. | `packages/gateway/src/server.ts` heartbeat/watchdog composition; `packages/kernel/src/evolution.ts` |
| Identity, memory and managed skills | Save owner SOUL/identity or skill, begin a real supported run and verify exact current prompt/tool availability; remember/search/forget is scoped and survives restart without reviving deleted memory. Managed upgrades preserve owner customizations. | `packages/kernel/src/soul.ts`, `memory.ts`, `memory-search.ts`, `skill-registry.ts`, `packages/gateway/src/chat/recipe-skill-context.ts` |
| Plugin lifecycle | Load configured plugin, expose actual tool/route/hooks, isolate failed plugin/service from gateway startup and stop services/hooks once on shutdown. Disabled/hidden UI is not evidence the headless capability can be deleted. | `packages/gateway/src/server/plugin-startup.ts`, `packages/gateway/src/plugins/`, gateway close path |
| Telegram voice and outbound recovery | Receive actual voice-note shape, call the injected speech service, dispatch transcribed text and return the bounded formatted reply to the same chat; preserve session and queued outbound delivery through failure/restart. | `packages/gateway/src/startup/channels.ts`, `packages/gateway/src/channels/telegram.ts`, `channels/telegram-stream.ts` |
| Attention, push and unread deep links | Register scoped device token, deliver the correct run/approval attention signal, open its exact Chat and clear unread on intended action; logout/token removal/preferences prevent later cross-owner delivery. | `packages/gateway/src/server/system-operator-routes.ts`, `coding-agents/attention-notifications.ts`, `coding-agents/notification-preferences.ts`, `apps/mobile/__tests__/push.test.ts` |
| CLI profiles and sync daemon | Select profile/computer, login, start one daemon, sync actual bytes, pause/resume, restart and logout; prevent cross-profile data/credential reuse and conflicting daemon ownership. | `packages/sync-client/src/cli/index.ts`, `cli/commands/profile.ts`, `sync.ts`, `peers.ts`, daemon entrypoint |
| CLI command and transfer contract | Execute real root wrapper/aliases, remote argv command, upload/download and attach/detach; propagate exact bytes/exit/signal and emit parseable JSON with no telemetry or secret contamination on stdout/stderr. | `packages/sync-client/src/cli/index.ts`, `cli/commands/run.ts`, `shell.ts`, `upload.ts`, `download.ts`, `doctor.ts` |
| CLI self-update | Check-only is read-only; detect install method, validate/download exact platform artifact, atomically replace only the executable and verify resulting version; failure preserves settings/sign-ins and recoverable original installation. | `packages/sync-client/src/cli/commands/update.ts`, `packages/sync-client/src/cli/self-update.ts` |
| Port forwarding and preview traffic | Forward explicit loopback port to exact selected computer over actual WS/HTTP, carry bytes/backpressure, deny non-loopback/foreign ownership, reconnect and close without orphan listeners. | `packages/sync-client/src/cli/commands/port.ts`, `packages/gateway/src/forward-ws.ts`, gateway `/ws/forward` registration |
| Remote-computer MCP | Real SDK client lists computers, selects one explicitly, runs bounded argv, uses stable terminal tab identity and reads/writes files/Chat; tool annotations match effects and invalid/foreign computer cannot fall back silently. | `packages/sync-client/src/mcp/server.ts`, `mcp/profile-context.ts`, `mcp/clients.ts`, platform `mcp-registration.ts` |
| Social and profile ownership | Owner publishes/reads/deletes post, comments/likes/follows and paginates feed/profile; duplicate actions keep counters consistent, private data does not enter public activity, and reconnect/reload shows canonical state. | `home/apps/social/matrix.json`, `home/apps/profile/matrix.json`, `packages/gateway/src/social.ts`, `social-activity.ts`, platform social registration |
| Default-app business actions | Notes edit/search/export, board/card move, recurring Todo, expense/budget/bill state, alarms/timers, persistent sticky notes, weather errors and Whiteboard export must work through the real sandbox bridge and survive reload/conflict. A generic bridge round trip cannot prove each app's main task. | All `home/apps/**/matrix.json`, with executable app sources and app-specific suites as the next validation boundary |
| Game rules and saved results | Legal chess/backgammon moves, puzzle win/loss, pause/restart and persisted scores/history; test real rules/engine, not a copied model or a fake engine that cannot reject illegal moves. | Game Center plus eight game manifests under `home/apps/games/` and `home/apps/winxp-minesweeper/` |
| Organization administration and ownership transfer | Invite/resend/revoke, accept membership, change role/logo/name, remove member, transfer ownership and delete organization; last-owner and shared-project ownership block account deletion until explicitly resolved. | `packages/platform/src/organizations/routes.ts`, `management.ts`, `roles.ts`, `account-deletion/routes.ts` |
| Account export before erasure | Download every paginated owner-runtime export plus platform export during allowed grace period; owner-scoped links, interruption/retry and exact erase boundary prevent leakage or false completeness. Include Apple authorization/revocation where required. | `packages/platform/src/account-deletion/routes.ts`, `export.ts`, `native-apple.ts`, `worker.ts` |
| Connected data refresh and cancellation | Installed app manifest and exact connection authorize a refresh, resumable import merges without replacing owner edits, failure/retry retains progress, and revoke/navigation stops new reads or stale completion. | `packages/gateway/src/startup/data-imports.ts`, `integrations/refresh/`, `packages/kernel/src/tools/data-imports.ts` |
| Packaged Electron update and auth focus | Actual packaged build checks proper channel, downloads/verifies, offers explicit restart/install, restores sessions and handles cold/warm `matrixos://auth` focus signals while polling remains auth truth. Distinct from VPS host-bundle update. | `desktop/src/main/updates.ts`, `update-config.ts`, `update-quit.ts`, `auth/device-auth.ts`, current root `AGENTS.md` desktop callback rules |

### Applicability and unsupported states

- `GATEWAY_ROUTE_GROUPS` is a useful grouping index, not a complete executable route registry. Actual source also mounts routes after authentication and conditionally on dependencies; test registration and configuration branches.
- `ChannelId` names Telegram, WhatsApp, Discord, Slack, Push and Voice, but the gateway channel startup directly registers Telegram/Push while Slack/WhatsApp have separate platform/runtime composition. A type union is not evidence an adapter is wired. For each channel record supported route, feature flag, real transport and explicit unsupported behavior.
- Web Settings hides Channels, Skills, Security, Cron and Plugins navigation in `HIDDEN_SECTION_IDS`; headless implementations still exist. Keep valid backend protections and require explicit product applicability rather than deleting tests because a menu is hidden.
- `/system/backup` currently returns **501 after authentication**. Do not invent a successful backup journey from the route name. Preserve unsupported/authentication assertions and separately track the missing full backup/restore capability.
- Root `CONTEXT.md` still describes Canvas as primary, Desktop as compatibility and `__workspace__` routing. Current `AGENTS.md` says Desktop is default and Workspace Canvas is retired. Use the current owning source and explicit product instructions; legacy specs and docs cannot automatically certify current behavior or justify deleting recovery compatibility tests.
- Support/resource diagnostics and operator-only actions need a denied unauthorized path and privacy/redaction checks; displayed health is not proof every dependency is ready. This expands the existing provisioning/security/release rows rather than treating support availability as a separate shipped capability claim.
- Every one of the 25 non-template apps needs an app-specific primary outcome in the per-test ledger. The two templates need build/bridge packaging contracts. A test-only runtime or substituted game engine must be recorded explicitly and cannot qualify the corresponding real app.

### Census integrity recheck

Recomputed from the saved raw download: 1,000 unique PR IDs, descending creation time; 604 merged/339 open/57 closed; 587 exact merge ancestors and 17 non-ancestors; 342 product-fix candidates, 242 merged and 240 exact merge ancestors. The 17 non-ancestor PRs are #2509, #2507, #2418, #2415, #2414, #2413, #2412, #2358, #2315, #2314, #2313, #2311, #2310, #2309, #2308, #2246 and #2146. They remain in the full 1,000-row ledger with an explicit inclusion caution; they are **not discarded from the history audit**. Squash/cherry-picked equivalents may exist at the pinned source and require a separate equivalence check.

All six 65,536-character descriptions remain in the ledger and the separate raw download. Their byte lengths are also recorded, so Unicode byte count is not confused with the character-size signal. `bodyMayBeTruncated` is a conservative completeness flag, not a finding that six bug-fix descriptions were lost.

## Testing-instruction changes justified by history

1. **State the business outcome and a concrete plausible fault before the test.** A new safety policy or timeout requires a requirement; do not freeze an arbitrary implementation choice (#2785 → #2788).
2. **Reuse the owning test and extend its scenario.** A new suite must add a distinct fault boundary or required runtime. Do not add another mock-only simulation of an existing handler.
3. **Use real producers and consumers together at protocol boundaries.** Validate serialized outputs with the receiving production contract; preserve cross-version fixtures where clients update independently (#2936, #1875, #1869).
4. **Match the production topology.** Direct SDK fixtures are insufficient for brokered storage; unmounted routes miss middleware/order; Node mocks miss Workers/native ABI behavior (#1939, #2010, #1858, #2431, #2249).
5. **Require recovery transitions.** For stateful work include reload/reconnect, partial failure, stale response, explicit retry and cleanup at the owning layer (#2634, #2606, #2680).
6. **Prove a bug test fails for the actual original fault.** Keep a bounded red/green or targeted mutation result. A compile/import failure is not proof the assertion detects the bug.
7. **Keep useful static contracts, but label their limit.** Native symbol, packaging, auth-registration and migration guards can catch real defects; CSS/source presence is not interaction or rendering proof. Never delete solely because a test reads source.
8. **Separate fast deterministic regression from runtime acceptance.** Cheap integration tests catch most interleavings; actual OS/browser/device input qualifies clipboard/keyboard behavior. Do not multiply live journeys across every low-risk PR.
9. **Make execution truth explicit.** Required cohorts fail if absent or skipped; record exact source, backend, platform, fixture/auth bypass, case count and outcome. A source path or historical author claim is not a current pass.
10. **Measure cost against unique protection.** Remove proven disconnected/duplicated tests with dependency/coverage/fault evidence. Preserve auth, money, data, concurrency, interoperability and required-runtime protections; never obtain a speedup by weakening expectations or silently skipping them.

## Reproducible artifacts

The history workstream generated the following external evidence files, retained outside Git:

- `pr-ledger.json`: every PR, intent/domain/risk signals, state, exact source ancestry, changed paths, existing test references, evidence depth and uncertainty.
- `pr-summary.json`: reproducible counts; automatic classification remains explicitly identified.
- `regression-mechanisms.json`: 48 reviewed fault mechanisms, lowest useful layer, required fault proof and existing tests to reuse.
- `patches/`: 47 cached local merge patches; the separate supplied #2936 patch is retained alongside the raw metadata download.
- `build-ledger.py` and `annotate-regressions.py`: census and review annotation generation.

This report does not close the full audit. Completion requires reconciling these requirements with the per-test ledger and proving the important journeys on their owning runtimes. No full-suite pass, full mutation score, production deployment, CI speedup or exhaustive semantic review of all 1,000 patches is claimed.
