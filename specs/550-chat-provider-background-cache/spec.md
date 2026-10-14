# Electron Desktop Chat provider background cache (ENG-168)

## Outcome and scope
Returning to Chat shows its already loaded provider/model choices immediately. Ordinary provider discovery runs silently outside Chat component lifetimes and does not block sending.

This client-session optimization covers Electron Desktop ordinary/project Chat, Bot controls, and agent conversations. Web Canvas, Web Desktop, Web Mobile, and Native Mobile keep their existing lifecycle. Shared provider derivation and admission semantics remain canonical; there is no new provider capability or duplicated platform business logic.

## Behavior contract
1. A single bounded in-memory catalog is owned by the Electron authenticated application scope, not Chat visibility. Login/runtime readiness prewarms before Chat opens. Unmount/hide/reopen does not discard successful data. No disk persistence is added.
2. Separate cold `initialLoading` from background `refreshing`. Only a cold pending observation displays discovery loading. A successful empty catalog settles to an empty state. A routine delayed/failed observation retains same-scope choices, draft, selection, slash entries, and sending affordances.
3. Ordinary freshness is five minutes. A root-owned scheduler refreshes due observations while connected; focus/visibility/picker opening never initiates a request, including indirect onboarding callbacks. A bounded 30-second wake check compares the wall-clock deadline without fetching before it is due; resume and network recovery reconcile due work. Close/logout cancels owned work and drains timers/listeners.
4. Shared consumers join one request. Normal reads do not force every native catalog probe. Accepted Settings/funding/setup/recovery events and explicit refresh can bypass freshness; a mutation during a read requires a coalesced newer observation. Never let an older response overwrite a newer settings epoch.
5. A transient refresh error is not a provider revocation. Retain previously validated presentation and retry with bounded backoff. Conversely, identity/auth changes and confirmed revoked/disabled provider routes synchronously lose actionable old authority. Generic unknown Settings invalidation remains conservative until new validation succeeds; do not claim unaffected routes without affected-route evidence.
6. A newly unavailable current model stays selected with canonical unavailable/recovery copy. Never silently substitute a different provider/model or violate immutable existing Chat binding. Preserve the canonical composer preferences, options, draft and `pickerTouched` contract.
7. The cached catalog is presentation, not permission or funding authority. Every send remains subject to current gateway/local subscription admission. A cached positive status cannot approve a turn, guess a balance, or unlock unknown liability.

## Ownership and invariants
- Source of truth: authenticated gateway catalog and current server admission. Cache scope includes account, platform, runtime and auth generation; no credentials are stored.
- Concurrency: capture scope, request generation and accepted-mutation epoch; ignore late responses synchronously across identity changes. ApiClient replacement alone is not account identity. All network reads remain cancellable and timeout-bounded.
- Resources: one retained active-scope entry; one coalesced request; owned timer/listeners; explicit cancellation and teardown. No unbounded Map/Set or disk snapshots.
- Persistence/transactions: no new database/file writes, migrations or owner-data modifications. Existing settings mutations and funding rules remain server-owned.
- Deferred: application-restart disk cache, new main-process IPC client, gateway endpoints, other-shell cache rollout, default model substitution, production deployment and fleet promotion.

Existing network boundaries remain unchanged:

| Existing route | Authentication and authority | Public |
|---|---|---|
| `GET /api/chat-providers` | Trusted Electron core injects native bearer credentials; gateway validates the current owner/runtime. Renderer validates the canonical catalog schema. | No |
| Chat turn, queued-turn and run submissions | Existing native bearer authentication and gateway/local-subscription admission. Cache availability cannot approve execution or funding. | No |
| Provider Settings mutations | Existing validated Settings transport and accepted server revision; only accepted changes invalidate cached authority. | No |

## Wiring and acceptance
The existing desktopQueryClient stores provider snapshots; an application-root coordinator owns scheduling. useChatProviderCatalog projects/subscribes; Chat active/live flags cannot own cache lifetime. Ordinary/project Chat, agent conversations, Bot selectors and recovery, and accepted Settings invalidation use this shared path. Do not turn a background fetch flag into picker loading or a composer send gate.

CanonicalChatWorkspace already exceeds 1,000 lines. This change adds behavior in focused cache/admission modules and only adapts its existing composition wires. Its extraction plan is to move bound-route recovery and turn-admission orchestration into dedicated hooks, then isolate conversation lifecycle from workspace rendering; preserve the current binding and queued-turn regression coverage during that follow-up.

Tests first must prove: shared requests, warm hide/reopen retention, twenty switches with no extra catalog request/spinner/send block, prewarm before consumers, authoritative empty result settlement, delayed/failed refresh usability, selected-route unavailability without replacement, known/unknown settings authority fences, queued mutation refresh, same-object and replacement transport identity races, cancellation, offline backoff, and timer cleanup.

Production-built Electron fixture evidence must exercise actual application-root wiring and visible picker/composer; label it separately from authenticated live runtime acceptance. Record exact build commit/app path and backend runtimeVersion for real Electron Human Review. Local tests alone do not establish live provider or send acceptance. No paid model/tool request is needed to prove selector cache behavior.

## Delivery
Use an isolated manual codex/ worktree and Conventional Commit implementation PR, one English Linear issue ENG-168, and a separate public documentation PR in FinnaAI/matrix-os-site content/docs. Stop with an exact-head runnable Electron Desktop and concise Human Review flow. Greptile and merge follow explicit user review approval; no production rollout is authorized by this task.

## Shared Settings evidence expiry (ENG-178)

A short local credential observation is a validity bound, not an instruction to repeatedly reload the complete Settings snapshot. Idle Agents & providers and retained Chat onboarding must not renew `/api/ai/provider-settings` merely because Hermes's five-second `present_unverified` evidence expires. This shared controller contract applies to Web Canvas, Web Desktop, and Electron Desktop; the application-owned Electron catalog schedule above remains independent.

Keep display-only local expiry rerenders and canonical admission. Expired historical Hermes profile presence remains recoverable and must not become fabricated authentication or a logout. Preserve the existing stale connection presentation and saved configuration. Do not increase the server TTL to hide repeated reads.

Initial identity-scoped reads, explicit Refresh, connection revalidation and bounded active login/workflow completion keep their existing safe transport and request/revision/identity fences. Only these actual accepted snapshots may trigger their normal workflow capabilities or expanded connection reads. Idle expiry must retain expanded rows, scroll and enabled controls without global busy transitions or secondary network fanout.

Regression evidence must cover fresh successive short-TTL responses, hidden mounted Chat, truthful expiry, one explicit refresh, and stale-identity cancellation. Required production Electron coverage observes idle Settings beyond two complete TTLs and manual Refresh without rearming a timer. Fixture and live QA evidence are separate facts. Deliver ENG-178's implementation PR and a separate public documentation PR; stop at Human Review before Greptile or merge.

### Provider icon contrast

Agents & providers keeps the white upstream OpenCode and Pi artwork on the matching canonical `CODING_AGENT_ARTWORK` background in both appearances, using the shared `HarnessIcon` across Web Canvas, Web Desktop and Electron Desktop. Keep the original shipped assets and other harness icons unchanged. Verify the actual PNG glyph pixels against their rendered background at contrast ≥3 across native/Web light/dark token mappings; transparent padding is excluded from glyph measurements.

### Idle freshness presentation

`Checked` describes the last accepted snapshot's age and must advance on an unchanged mounted page. Its local display clock must not refresh the snapshot, capability inventory or any connection workflow. Keep clock invalidation inside the age presentation rather than rerendering the complete Settings workspace every second.

Managed-credit display retains its existing five-minute validity, measured from `usage.asOf` with matching `chatAvailability.asOf`. Expire the displayed current amount at that deadline without requiring an unrelated click. The existing `Chat credit unavailable` and last-confirmed presentation is conservative stale evidence, not proof that money was spent or removed. Explicit Refresh obtains another authoritative snapshot; local time cannot extend the old observation's validity or grant execution authority.

Reuse bounded local expiry with an explicit time dependency for derived child presentation under React Compiler. The owning gateway selection derivation also invalidates at the credit deadline, so saved/unbound connection choices cannot retain an enabled Matrix action or selected-ready affordance after the amount expires. Preserve source/route precedence and server authority. Clean up clocks/deadlines on unmount and reconcile new timestamp props without retaining an old observation's deadline. Regress unchanged idle rendering, exact expiry, observation replacement, no request/capability fanout, preserved disclosure state and timer cleanup. Verify actual production Electron separately through the sole acceptance executor. The reproducible UI clock defect does not establish the unobserved live unavailable cause.
