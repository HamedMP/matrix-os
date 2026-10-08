---
status: active
---
# Shared app capabilities

Apps must use the same owner-authorized integrations and AI contracts on Web Canvas, Web Desktop, Electron Desktop, Web Mobile, and Native Mobile. Drive Chat currently fails because Electron exposes no integration methods. Native Mobile has no app bridge. The web service bridge denies production calls. App AI is kernel/Claude-only. Keep credentials in trusted hosts and the gateway, bind app identities in hosts, and fail closed for missing grants or unavailable routes.

## Delivery stack

Feature implementation is completed. Delivery is split into five ordered PR
layers for independent review and CI; merging and live release verification
remain separate from implementation completion.

| Layer | Scope | Dependency |
| --- | --- | --- |
| 1. Core | Shared capability/AI contracts, production integration authorization and owner grants | Base branch |
| 2. Hosts | Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile brokers, full installed app identity, shared database reply budget, builder guidance | Core |
| 3. Standalone executors | Bounded text-only completion adapters, exact credential proofs, cancellation/drain and focused executor tests | Hosts |
| 4. Connected AI | Common V3 readiness, route catalog/selection, runtime composition, exact account/source/model dispatch and owner policy compatibility | Standalone executors |
| 5. Chat | Explicit read-only built-in integration tool scope, Chat authorization/composition and scope documentation | Connected AI |

Each layer preserves its predecessor's behavior and needs its own review/CI
result. Unsupported completion routes remain unavailable. The companion public
documentation PR ships from the private site repository; installed customer
behavior is verified only after reviewed artifacts are released and exercised.

## U1: Shared contract and production integration authorization
Goal: ship validated capability contracts and authenticated integration calls with owner-controlled per-app grants; preserve legacy development callers without opening the production bridge indiscriminately.
Files: packages/contracts/src/app-capabilities.ts, packages/contracts/src/index.ts, packages/contracts/package.json; packages/gateway/src/app-capabilities/**; packages/gateway/src/integrations/bridge-routes.ts; tests/contracts/app-capabilities.test.ts; tests/integrations/bridge-routes.test.ts; gateway composition registration.
Approach: shared bounded schemas/client. Keep `MatrixOS.service(service, action, params, label)` and `integrations()` compatible; host stamps app identity. Owner grants under system/app-capabilities.json list exact service/action grants. New production calls require trusted owner and exact app grant. Connected accounts and action catalog come from runtime services, including direct OAuth and MCP where supported. No browser credentials, arbitrary URL fetch, or self-granting manifest permission.
Execution note: test-first.
Verification: production successful authorized reads; deny absent/revoked grants and other principals; action payload limits; multiple-account selection; unavailable integrations; no credential projection.

## U2: Electron capability transport
Goal: expose service/integrations/capabilities through the registered native app view with identical shared clients.
Files: desktop/src/shared/native-app-capabilities.ts; desktop/src/main/embeds/native-app-capabilities.ts; desktop/src/main/embeds/native-app-bridge.ts; desktop/src/main/index.ts; desktop/src/preload/index.ts; tests/desktop/native-app-capabilities.test.ts; preload tests.
Approach: separate focused requester/IPC module, registered sender identity and exact route binding, authentication-generation invalidation, top-frame only; timeout and response bounds; no renderer-supplied app identity or token. Use U1 contract.
Execution note: test-first.
Verification: actual preload calls reach IPC/requester with server-bound app identity; reject stale sender, subframe, malformed requests and navigation; safe response errors.

## U3: Web and Native Mobile app transport
Goal: same usable integration/AI capability methods on shared web AppViewer and native WebView.
Files: shell/src/components/AppViewer.tsx; shell/src/components/app-capability-request.ts; shell/src/lib/os-bridge.ts; apps/mobile/components/AppRuntimeFrame.tsx; apps/mobile/lib/app-capability-bridge.ts; relevant tests.
Approach: trusted host broker validates source/frame and stamps identity. Native WebView communicates through bounded request/reply messages; bearer stays in native host. Reject untrusted navigation, stale launches and arbitrary endpoints. Use U1 contract and retain existing DB APIs where available.
Execution note: test-first.
Verification: web generated script roundtrip; Native Mobile bootstrap installed before application initialization; broker authorization, navigation and lifecycle tests; parity API shapes.

## U4: Owner-selected connected AI routes
Goal: app AI discovers and executes the owner's runnable V3 AI routes, instead of hardcoding Claude. Keep owner app grants, funded admission/metering and no silent fallback.
Files: packages/contracts/src/app-ai.ts; packages/gateway/src/app-ai/**; gateway composition; app AI and provider routing tests. Coordinate composition edits with U1 owner.
Approach: inspect existing V3 snapshots and execution adapters first. Select exact owner-enabled route/account/access source/model and allow explicit selection; retain old app-ai.json policy compatibility. Do not invent readiness, bypass funded admission, expose credentials, or run unrestricted tool-enabled agents for completion. Isolated temporary execution and cleanup mandatory.
Execution note: test-first.
Verification: connected non-Claude route, legacy policy, unavailable/disabled routes, revoked grants, cancellation/timeout, bounded text and truthful routing.

## U5: Builder guidance, documentation and release validation
Goal: generated apps discover actual capabilities/action schemas and test real launches, never guess APIs or tell owners to fix runtime bridges manually.
Files: skills/matrix/app-builder/**; skills/matrix/integrations/**; skills/matrix/debug-app/**; home/agents/knowledge/app-generation.md; docs/dev/app-capabilities.md; skill tests; separate FinnaAI/matrix-os-site content/docs documentation PR.
Approach: document grants, connection/readiness errors, actual integration shapes, ai.generate vs legacy generate, file previews, pagination and responsive parity. Public docs remain customer-safe. Full regression and independent review before PRs. No merge or fleet deployment in this task.
Verification: focused tests and typechecks, desktop build, mobile bridge tests, shared web roundtrip, code review, Matrix PR and companion public docs PR. Live recovery remains unverified until reviewed desktop/runtime artifacts are installed and exercised.

## Auth matrix
| Boundary | Auth / app identity | Limits |
| --- | --- | --- |
| Web app -> shell | Exact registered iframe and app; shell stamps identity | Bounded request and reply, timeout |
| Electron -> main | Registered main frame, route origin, auth generation | Schema validation, 64 senders, response cap, timeout |
| Native WebView -> host | Exact launched app route; stale launch/navigation rejected | Bounded pending replies and message sizes, timeout, unmount drain |
| Integration/AI gateway routes | Authenticated owner plus exact app policy grant | Body limit, bounded params/output, service timeout |
| External integrations/AI | Existing owner account and runnable route | Existing admission/metering, no secret projection |

## Invariants
Source of truth: owner policy plus connected integration registry and V3 AI readiness. Grants are read each call and rechecked before execution. No new app database persistence. Scratch files explicitly deleted; pending registries capped and drained. Credentials remain in trusted hosts/gateway. Unsupported content or routes return safe availability states rather than guessed success.
