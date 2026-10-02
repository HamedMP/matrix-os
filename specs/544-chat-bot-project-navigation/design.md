# Technical design

Final UI scope approved; implementation is active on the current Matrix AI dependency stack.

- Reuse spec 536/ENG-49 Bot runtime, binding, authority and memory. Coordinate ENG-107 route/model and ENG-65 Settings. Do not create a parallel runtime.
- Keep canonical owner Postgres transcripts and stable Bot/Chat/Project IDs. Derive explicit server-authorized conversation classification; do not rely on names or assume driverKind identifies every older Bot. List separation is non-destructive.
- Route center state as home, ordinary Chat, Project landing, Bot library/setup or Bot conversation. Preserve the current expandable Projects/Chats tree; Project selection differs from expansion. Render the shared rail in the exact user-specified order with Recent last, and keep New chat in a sticky top region that remains visible while the rail scrolls.
- Reuse current AgentAvatar -> RecipeRabbit visuals in existing icon slots across applicable surfaces; do not substitute Figma circular letter avatars.
- @Bot candidate selection resolves stable identity through authenticated directChat API, navigates and pre-fills composed text without auto-send, source-provider switch or grant widening. Preserve any target draft and keep incoming text recoverable in the source on conflict/failure. Guard stale async navigation and active streaming.
- Reuse shared status and attention helpers, canonical events, Bot detail and approval contracts across renderers. Pending Bot approvals also project a Needs you reminder keyed by stable Bot/Chat/approval identity. Clicking it opens the same bound Bot Chat; deduplicate reminder state and invalidate it when approvals resolve or summaries refresh. This reminder is not an ordinary Chat list entry.
- Project assignment updates must preserve binding/root semantics, active-run conflicts, optimistic revision and transactional relation writes.
- Keep @Chat and Company Drive resources separate from Bot navigation. Capability eligibility must come from trusted contracts.
- Provide a Bot-specific selector at conversation start using existing Automatic and ENG-107 managed model choices. Exclude unsupported recipe runtime choices and explain unavailable reasons. Keep current routing semantics; show resolved source only from authoritative metadata and never label Automatic as exclusively Matrix-funded. Future Hermes/personal-subscription Pi adapters are outside this UI release.
- Project integration eligibility as the intersection of runtime-served tools, recipe declarations, model tool support, fresh source readiness, connected exact account, Bot grant and approval requirements. Unconnected, unsupported, permission-required and credit-required states are distinct. Do not change backend funding/fallback policy in this release; explain observed selection and failures truthfully. Company Drive remains unavailable on Pi/Hermes until its authorized path exists.
- Reuse `/api/chat-agents/:agentId/direct-chat`, `/api/chats/:chatId/bot`, canonical Chat and Bot interactions/authority endpoints. Introduce no new endpoint. Preserve current authentication, scoped authority, revision/idempotency checks and safe errors through existing clients.
- Preserve older multiple Bot histories and existing coding-Agent definitions without migration or consolidation. Restyle supported lifecycle/setup controls only; defer any engine/API behavior missing from the existing backend.

Proposed independent slices: Bot identity/list/@ continuity; unified state rail/Project view; Bot creation/details/approval; provider/context/discovery. Scheduler is deferred to ENG-93. Use these as ordered, independently verifiable slices within this task; no extra Codex chats or duplicate issues have been created. Shared identity/navigation must precede rail/Project changes; existing Bot surface/picker polish follows shared wiring; docs and acceptance depend on the final UI revision.

Rollout remains additive and reversible, preserving owner records. No production deployment or stack auto-merge. Require exact-head Preview/Electron and applicable surface parity; separate public docs PR in FinnaAI/matrix-os-site.

## Existing surface constraints

- Electron Desktop owns the execution-Project tree and Project center described in R4. Current Web Desktop/Web Canvas Chat is a global canonical Chat host (`createCanonicalShellChatClient.list` requests `scope=global`); its existing Projects navigation is Organization Drive projects, not the execution-Project management surface. Retain that authorized discovery/file behavior rather than relabeling an organization Drive as an execution Project. The new shared Bot navigation/identity/model/attention behavior and canonical lifecycle grouping apply to those Web hosts. A future execution-Project Web host must supply the existing project/context contracts before claiming that center view.
- Native Mobile already opens direct Bot conversations and supports their model/authority controls. Apply list exclusion and Bot approval attention there, and provide a collapsible Agents section so every known Bot history stays reachable after exclusion. Reuse the current rabbit asset and existing direct Chat opener. It has no @Agent candidate picker; adding one is outside this existing-surface restyle.
- Shared per-PR Preview intentionally cannot proxy personal integrations. Test truthful unavailable states there; don't enable broader access to satisfy a visual fixture.


## Executable client contract

### Scope and signatures

This release changes client projection and navigation only. Reuse `ChatAgentClient.bots.directChat(agentId): Promise<string | null>` and `directBot(chatId): Promise<string | null>`; no route, schema, funding policy or server authorization changes. `useDirectBotBinding(chatId, client, resolvedId?)` returns `agentId`, `status: loading | error | bot | ordinary`, and explicit retry. A pre-resolved value is trusted only when supplied by the authenticated host client.

`useBotMentionNavigation(client, scope, open)` resolves Agent identity before invoking `open(chatId, text): boolean | Promise<boolean>`. A true result means the target accepted prefill; false means an existing target draft remains intact. Selection never sends a turn. The source remains recoverable until its host explicitly clears an unchanged draft. A matching authenticated non-recipe Agent with a null direct binding may use the existing inline path; missing/deleted recipe identities may not.

### Projection and limits

Shared Electron/Web Bot summaries classify the host's loaded history through the authenticated binding APIs. Cover at most 1,000 loaded records with four concurrent reads; overflow and failed reads remain unresolved and never become ordinary Chats. Cache up to 1,000 binding entries for 30 seconds with oldest-entry eviction. Refresh every 15 seconds while visible, on focus and on host refresh events; stop queued I/O when the client/scope changes. Native discovers current recipe bindings independently of the recent Chat window, adds historical loaded bindings, and uses scoped React Query keys with four concurrent reads. Query data becomes stale after 15 seconds and inactive cache entries are collected after 60 seconds; foreground refresh pauses in background.

Draft stores are scoped to the client and bounded to 100 records. Project center selection retains the mounted draft host; expanding the Project tree does not select it. Recipe creation keeps its idempotency key through both instantiate and host-open, then clears it only on complete success.

Conflicting @Bot handoff offers an explicit Return to original draft action. It restores the captured source Chat or unsent draft scope without invoking New chat reset, submitting text, or replacing the target draft. The recovery notice is visible only for its target Chat and current actor/runtime; changing authority clears it. Intentional New chat remains a fresh-draft action.

Local attachments are not retained across the current composer unmount. While a source draft has local attachments, @Bot navigation stays in the source and explains that the attachments must be removed or sent first. This protects draft resources without adding a new attachment persistence layer.

### Validation and error matrix

| Evidence | Required client behavior |
| --- | --- |
| Binding loading or failed | Withhold ordinary provider/context actions; retain draft; offer retry on failure |
| Authenticated Bot binding | Open the same bound Chat; exclude it from ordinary lists; retain a Bot entry |
| Unknown/deleted mentioned Agent | Safe error, preserved source draft, no inline Agent token or send |
| Existing target draft | Preserve target and source; do not overwrite or send |
| Newer navigation before lookup finishes | Ignore old response; accepted host navigation may close its own sidebar |
| Pending approval with future `expiresAt` | Separate Needs you entry opening the original Bot Chat |
| Resolved/expired approval | Remove reminder on refreshed authoritative state |
| Retained catalog during refresh | Display retained choices but disable edit/create until refresh resolves |
| Older Agent library revision after save | Preserve the newer acknowledged editor/model revision |
| Failed list or cross-runtime response | Safe generic error; no previous runtime's state or permission projection |

### Cases and assertion points

Good: opening a named Bot and mentioning it both reach the same persisted transcript with no new conversation or autosend. Base: an ordinary Chat with a confirmed null binding keeps the current coding provider controls. Bad: treating an unknown Bot lookup as an ordinary Chat, or injecting an Agent token into the source after a deleted recipe lookup.

Required behavioral tests cover identity failures/retry, history beyond the former classification boundary, scoped cancellation/concurrency, target/source draft conflicts, stale navigation, accepted host close, expiring approvals, catalog refresh and model revision races. Event test fixtures must support multiple subscribers and remove only the disposed subscriber. Live acceptance additionally requires the same committed Electron source and installed Preview version, actual rail/project/Bot interactions and screenshots; unit fixtures cannot establish live admission or integration access.

Wrong: `if (!agentId) showOrdinaryComposer()` while binding is loading/error. Correct: render ordinary controls only for `status === "ordinary"`, Bot controls for `status === "bot"`, and a retry/loading surface for other states.

During binding recovery, only new composer input and admission-dependent Steer/Edit actions are gated. Already-authenticated queue Cancel/Reorder and active Run Stop remain available through their existing revisioned controllers. Identity unavailability must not prevent stopping existing work. Route regression tests cover ordinary, failed, and pending binding using real cancellation request adapters.

A named inline-size Project container inside the horizontal WorkTab flex host must explicitly fill the available width and participate in flex growth (`min-w-0 w-full flex-1`). Otherwise intrinsic-size containment collapses its width, clips the title/composer and prevents responsive card queries. Acceptance must inspect actual Electron pixels at windowed and maximized sizes; accessibility text and jsdom state alone do not establish geometry.

Latest dependency c5c32de453 omits the owned Pi runtime from Bot headers, editors and cards. Preserve Persistent history and Details from this redesign, while displaying Model and authoritative routing/funding labels. The backend remains the existing owned Pi path.

The pre-existing after-inline-reference mention cursor mismatch is tracked separately in [ENG-109](https://linear.app/matrix-os/issue/ENG-109/fix-chat-mention-cursor-offsets-after-inline-reference-tokens). Recovery tests cover supported before-reference mention insertion and do not claim that editor defect is fixed.
