# Runtime and client research: on-premises and air-gapped Matrix OS

**Baseline:** `231eff01cf7f67a0c135653848093c30fda3b90d` (`origin/main`, 31 October 2026).

**Method:** source inspection of production composition, routing, process launch, credentials, catalogs and clients. No local model was downloaded, no model inference ran, and no runtime/device qualification is implied. Line references refer to this baseline.

**Status:** engineering research and proposed design; no runtime implementation or license change.

## Main conclusions

1. Matrix already has several useful local-capable seams. A claim that every Chat path requires the Claude SDK would be inaccurate: canonical Chat adapters include Hermes, OpenClaw, coding harnesses and managed Pi. The legacy/background dispatcher remains Claude-specific.
2. Generic Pi/OpenCode discovery already observes owner-local native catalogs and profiles. These are the best first spike candidates, but their current Matrix coding adapters are read-only. Listing a local model or producing text cannot establish app-building capability.
3. Changing one endpoint policy cannot enable the complete product. Hermes settings, App AI, Bots/managed Pi, background work, and clients have independent admission/execution boundaries.
4. Mobile has an actual self-host connection flow today, despite older cloud-only specs. Its root still requires Clerk configuration and Clerk loading, making a fresh, disconnected start a separate blocker to qualify.
5. Use shared open-core contracts for runtime capability, endpoint policy and local execution. Place optional enterprise orchestration above those seams; do not maintain an EE copy of the gateway/kernel or hide basic security fixes in EE.

## Production execution map

| User/runtime path | Verified composition and boundary | Air-gap implication |
|---|---|---|
| Canonical ordinary Chat | `packages/gateway/src/server/initial-chat-adapters.ts:9-20` composes kernel, Hermes and OpenClaw adapters; `server.ts:1632` begins composition with coding/managed adapters added elsewhere. `chat/provider-adapter.ts:128-205` owns selected route, owner/run context, events, recovery, approval, input and cancellation. | Extend these contracts and composition rather than creating a second EE Chat implementation. Inventory each driver independently. |
| Kernel-backed Chat and legacy dispatcher | `packages/kernel/src/kernel.ts:131-159` calls the Claude Agent SDK query implementation; `packages/gateway/src/dispatcher.ts:133-134,226-248` resolves kernel credentials and defaults to `spawnKernel`. `kernel-settings.ts:7-23` admits Claude model IDs. | A configurable HTTP hostname is insufficient. A local-capable background/agent executor must preserve kernel tools, approvals, context and persistence or explicitly declare unsupported features. |
| Proactive background work | `packages/gateway/src/heartbeat/runner.ts:47-58` invokes `dispatcher.dispatch` with background funding class. `server.ts:1076-1108` invokes that dispatcher for self-healing, with backup/restore. | Route scheduled agent work and healing through the same approved local execution contract as interactive work. Turning these off is a documented reduced-capability profile, not full equivalence. |
| Cron notifications | `packages/gateway/src/server.ts:1130-1145` wires cron triggers to `channelManager.send`, distinct from the proactive heartbeat. | Do not conflate notification scheduling with agent task execution. Internal-only destinations must be selectable; internet channel adapters remain unavailable inside a strict air gap. |
| Hermes Chat | `chat/hermes-provider-adapter.ts:636-670` launches the owner-installed Python runtime with an explicit environment, per-run integration capability and optional shared-browser integration. `chat/hermes-selected-route.ts:10-60` confirms the selected native route from session events. | Preserve selected-route verification, per-run capabilities and bounded lifecycle. Establish an internal inference route and disable all auxiliary cloud calls before claiming independence. |
| Hermes provider settings | `agent-config/hermes-adapter.ts:40-69` checks the native catalog and validates supplied base URLs. `agent-config/base-url-policy.ts:40-82` requires public HTTPS/DNS addresses and rejects local/private origins. | Add an administrator-controlled internal endpoint policy with exact origins/trust configuration; keep ordinary user-supplied URL SSRF controls. Do not simply permit every private address. |
| Generic Pi/OpenCode coding Chat | `chat/coding-provider-adapter.ts:52-83` supports both drivers but maps them only to supervised/read-only operation. `coding-agents/pi-provider.ts:196-209,347-366` enforces a read-only tool list; `opencode-provider.ts:710-711` rejects broader modes. | Useful first local-model proof, but current adapters cannot deliver full coding/app-generation parity. A separate sandboxed, brokered write-execution increment is required. |
| Managed Matrix AI Chat | `chat/managed-chat-catalog.ts:81-115` projects managed Pi routes; `chat/managed-pi-route.ts:35-40` resolves exact managed, ChatGPT-plan or owner-Anthropic choices. | Existing managed Pi cannot automatically be relabeled as local inference. Introduce an explicit internal access source without Matrix-funded credential acquisition or cloud fallback. |
| Bots | `bots/route-resolver.ts:19-24,51-91` restricts default routes to Matrix Cloudflare, Matrix Anthropic or owner Anthropic sources, requiring eligible tool-capable models. `bots/broker-inference.ts:79-116` owns credential injection and bounded forwarding. | Extend route/access-source types and gateway broker authorization; keep isolated workers credential-free and unable to reach arbitrary LAN services. |
| App AI | `app-ai/connected-routes.ts:24-61` projects exact enabled and ready route lineage. `app-ai/runtime.ts:98-201` verifies selected routes and SDK support. `app-ai/pi-sdk-worker.ts:42-49,110-127` only accepts named public HTTPS hosts despite loading custom model metadata with network catalog refresh disabled. | Add internal text-completion support as a narrowly scoped broker/worker capability. Preserve app grants, route binding, response limits, cancellation and no-tool isolation. |
| Older App AI SDK helper | `packages/kernel/src/app-ai.ts:13-32` imports Claude Agent SDK for a one-turn text-only invocation. It remains called by historical model-only policies in `packages/gateway/src/app-ai/runtime.ts:312-330` and by `app-ai/claude-profile-completion.ts:42`. | Migrate historical policies deliberately; replace active callers or make the unavailable capability explicit. The newer App AI worker does not cover every helper. |

## Existing local model support: reuse and missing proof

### Catalog and native-profile seams

- `ai-providers/generic-harness-model-catalog.ts:242-305` invokes Pi with `--list-models --offline --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve`; OpenCode uses its `models` command with project configuration and auto-update disabled. Calls are capped and timed out. Pi catalog discovery can therefore be investigated without introducing a new remote model catalog.
- `ai-providers/generic-native-profile-observation.ts:73-100` reads fixed owner-local settings and auth metadata, observes explicit defaults, and returns `present_unverified` rather than claiming remote authentication. It does not inspect custom model configuration as a replacement for credentials. Keyless local servers require a tested representation; do not fabricate a verified account.
- `coding-agents/pi-provider.ts:715-726` and `coding-agents/native-harness-auth.ts:18-35` still use presence of a bounded, nonempty native auth file to determine coding-provider availability. An endpoint that needs no credential may therefore need an explicit credential-less capability rather than an invented authenticated cloud source. Verify both overall provider readiness and per-model admission.
- `packages/contracts/src/provider-settings.ts:706-734` accepts exact Pi/OpenCode native profile routes. `:754-764` permits a locally observed route only when the eligible model and fresh `present_unverified` observation match. Preserve this distinction between configuration, attempted execution and successful readiness.
- `chat/configured-harness-catalog.ts:28-61` projects a native profile's eligible models, with a bounded visible catalog; it does not require every generic provider ID to be a named cloud vendor.
- `coding-agents/pi-provider.ts:226-230,347-367` passes the selected provider/model to Pi and disables extensions, skills, context files, update checks and telemetry for canonical runs. That is useful protection and a compatibility constraint: native extensions/skills cannot be presumed active.
- `coding-agents/pi-process-environment.ts:8-16,22-50` allowlists process metadata, proxy and CA settings and only projects portable Anthropic credentials in its credential helper. Internal CA support already has a seam, but generic bearer/mTLS credentials need explicit handling and redaction rules.
- `coding-agents/managed-harness-process-config.ts:122-163` returns the native environment unchanged for non-managed sources; only managed Workers credentials create a separate fixed Pi models profile. Preserve that separation when adding an internal source so managed cloud settings do not overwrite owner-local configuration.

### Required first spike

Use a disposable Linux host and synthetic owner data. Install the exact shipped Pi version and one pinned local model server/model before disconnecting. Configure only the owner-local native profile. Run through actual Matrix Settings/catalog admission and the canonical Chat event path, not a standalone `curl` or CLI-only demo.

Record:

1. Exact model, weights hash, quantization, server/runtime and Matrix build; model license and supported redistribution terms belong in the offline artifact inventory.
2. Cold catalog listing, first text request, streaming, one permitted read tool, attachment handling if advertised, cancellation and a subsequent independent turn.
3. Gateway restart and native process loss separately; determine resume/recovery support from the actual driver contract.
4. Credential-less local server behavior, authenticated internal server behavior, invalid certificate and revoked credential behavior.
5. No internet DNS queries or outbound attempts from gateway, child processes and clients, including failed attempts. OS-level capture/enforcement is required; mocking global `fetch` does not see child SDK/Python/browser traffic.
6. Prompt injection and write requests are denied under the current read-only driver. A model answer claiming success is not file-write evidence.

**Go/no-go:** text plus a read-only tool proves only a local read-only agent path. Full local Matrix requires brokered file/app writes, background execution and App AI qualification below.

## Background execution and permission design

Recommended shared-core contract, subject to a spike before commitment:

- A typed execution request contains owner scope, requested capability profile, immutable endpoint/model binding, execution root, cancellation signal, deadline and resumable state version.
- A backend advertises supported tools, vision, context limits, structured output, approval/input, cancellation, resume and write confinement. Catalog visibility must not imply capabilities that execution cannot enforce.
- Background jobs bind an explicit local route and purpose. They must not inherit whichever interactive provider was most recently selected, acquire Matrix-funded credentials, or choose cloud fallbacks on timeout.
- Reuse canonical Chat events and existing tool authorization/broker boundaries. Share the interface; keep Claude and local/Pi implementations separate. Do not make the entire kernel depend on enterprise code.
- Retain backup/rollback for self-healing; apply administrator policy to self-modification, dependencies and app installation. Model output cannot authorize a network destination, shell write, identity change or elevated operation.
- Scope-runtime Bots/managed Pi workers should continue using the trusted gateway inference broker. Internal inference access does not justify allowing their network namespace arbitrary LAN egress.

Before writing a new large adapter, identify an extraction plan for oversized composition files. Add registration/composition seams in focused modules; do not add a second monolithic branch to `server.ts`.

## Native and browser clients

### Web standalone exists; enterprise identity does not follow automatically

`shell/src/proxy.ts:174-187` bypasses Clerk in self-host mode, rejects reserved platform/native session headers, and rewrites gateway paths with the internal bearer. `shell/src/app/layout.tsx:64-91` omits Clerk/default organization wrapping in that mode, sets organization state to `none`, and omits billing tracking/identify.

This is a useful single-owner web foundation. It is not evidence of multiuser identity, organization RBAC, internally hosted collaboration or standalone native sessions. A corporate reverse proxy must not turn every internal user into the same owner. Define authenticated principals, membership and revocation independently of the commercial entitlement.

### Mobile: self-host support is present but Clerk-free startup remains unqualified

- `apps/mobile/app/sign-in-computer.tsx:16-18,81-95,118-127` offers an actual self-host Basic Auth connection path.
- `apps/mobile/lib/storage.ts:209-228` creates its credential and intentionally persists only the credential-free gateway record. Session recovery must therefore be designed and tested; do not claim the password survives a cold start.
- `apps/mobile/app/_layout.tsx:171-184` still requires a Clerk publishable key and mounts ClerkProvider. `:306-323` waits for Clerk `isLoaded` before selecting a self-host gateway when not signed in.
- `apps/mobile/lib/gateway-client.ts:291,1714-1745` supports Basic/Bearer authorization and secure transport requirements. `:770-784` uses a ws-token endpoint whose standalone support must be verified for each connection path.

Task: extract a profile-driven auth bootstrap so self-host clients do not instantiate/wait for hosted identity. Keep hosted login unchanged, and separately qualify internal CA trust, app/asset sessions, REST, terminal WebSockets, collaboration, logout and reconnect on iOS and Android. Push and app distribution need independent air-gap decisions.

### Electron: configurable origin exists but still expects platform device-flow APIs

`desktop/src/main/index.ts:253-264` accepts configured gateway/runtime-selection origins. `desktop/src/main/auth/device-auth.ts:71-78,96-116` calls `/api/auth/device/code` and `/api/auth/device/token`; `auth/auth-service.ts:437` requests `/api/auth/computers`.

Changing `OPERATOR_GATEWAY_URL` alone does not establish a login protocol with the standalone gateway. Either provide equivalent internal identity/device-flow endpoints or add a separate standalone auth strategy behind the same trusted-main-process credential boundary. Qualify packaged artifacts, gateway-scoped CSP, app embeds, upgrades and OS certificate trust. Renderer code must not receive administrator secrets to simulate a session.

## Auxiliary AI capabilities

- `packages/kernel/src/memory-search.ts:18-63` uses the local memory store and filesystem summaries. Do not add an external embedding dependency merely to make air-gap search work; inspect other search consumers before deciding whether local embeddings are needed.
- `packages/kernel/src/image-gen.ts:130,158-183` implements a Google image-generation endpoint. Ship a local provider or disclose that capability as unavailable; include default icon generation/onboarding in the test inventory.
- `packages/kernel/src/tools/web-search.ts:80-88,114,143-144,196` uses public Brave/Perplexity/OpenRouter/xAI services. A local knowledge search service is a different capability and must be labeled accordingly.
- `packages/kernel/src/tools/transcribe-audio.ts:49-64` already accepts an injected owner audio transcriber. Reuse that seam for local speech; the surrounding speech transport and native capture paths still need independent review.
- All agent-loaded custom MCP servers, skills, browser tools and generated apps can introduce network/dependency demand. A supported air-gap capability manifest must enumerate enabled/disabled tools and dependencies rather than rely on a global UI flag.

## Shared core versus optional enterprise layer

| Shared open core | Optional enterprise implementation/composition |
|---|---|
| Local model protocol adapters, exact route/model binding, owner-local credentials, capability contracts and safe errors | Organization deployment policy, approved model catalogs and centralized rollout controls |
| Network destination policy primitives and all baseline SSRF/sandbox/authorization fixes | Administrator-managed internal endpoint registry, organization policy distribution and audit export integrations |
| Standalone authentication strategy interface, principal semantics, credential custody, revocation enforcement | Enterprise IdP provisioning/SSO administration, directory synchronization and policy UI |
| Generic artifact verification/import, migration/restore safety and tests | Enterprise release service, fleet administration and commercial entitlement integration |
| Canonical client routes/events and profile-driven auth bootstrap | Managed organization installation experience and enterprise-specific settings |

This is a proposed product boundary, not a legal conclusion. Baseline local operation, owner data portability and security enforcement should remain useful without `ee/`. Enterprise modules may consume shared contracts; shared packages should not import EE modules. Composition roots select optional implementations explicitly. CI must build/test a checkout with `ee/` absent and an EE checkout against the same core revision.

## Dependency-ordered engineering tasks to incorporate in the main plan

| Increment | Owning paths | Outcome and required proof |
|---|---|---|
| R1: Local execution spike | `scripts/spikes/`, current Pi catalog/provider tests and disposable runtime | Exact installed Pi + local server works through actual Matrix route admission, stream/read/cancel/restart with blocked internet. Document failure honestly before promising implementation scope. |
| R2: Deployment capability contract | `packages/contracts/src/`, focused gateway runtime composition modules | Validated profile describes identity/AI/storage/network availability. Hosted defaults remain compatible; absent prerequisites produce safe unavailable states rather than fallbacks. |
| R3: Internal inference endpoint policy | `packages/gateway/src/agent-config/`, gateway inference broker and credential boundary | Approved administrator origins only; internal CA/mTLS or bearer support; redirects/address changes and credential scope tested. Do not broadly weaken arbitrary-URL validation. |
| R4: Sandboxed local write-capable execution | `packages/gateway/src/coding-agents/`, `packages/scope-runtime/`, canonical adapter modules | Real file edit and Vite app creation under approved workspace; protected paths, databases, credentials, unrelated owners and LAN targets remain denied. Retain read-only driver until broader mode is enforceable. |
| R5: Local background agent | `packages/gateway/src/dispatcher.ts`, focused executor modules, `heartbeat/runner.ts` | Background route does not call Claude SDK/Matrix funding; heartbeat/healing perform real approved work, cancellation and rollback with restart-safe identity. |
| R6: Local App AI and Bots | `app-ai/`, `bots/`, corresponding contracts and broker profiles | Exact local access source admitted; App AI remains text-only, no owner tool/file scope; Bot tools remain separately authorized; no alternate provider/account on failure. |
| R7: Client auth profiles | `shell/src/`, `desktop/src/main/auth/`, `apps/mobile/app/_layout.tsx`, mobile auth/client modules | Cold start and credential/session lifecycle work on internal identity alone; all hosted paths retain their regression lanes. |
| R8: Auxiliary provider capability | kernel tool/provider interfaces and speech composition | Each advertised speech/image/search/MCP capability has a local implementation or deliberate unavailable state. No startup stalls or hidden public requests. |
| R9: Qualification and evidence | existing gateway/contracts/shell/desktop/mobile tests plus full-runtime qualification lane | Real production-boundary assertions, network capture, backups/restarts and named-surface screenshot/recording evidence at exact build. |

Tests should extend existing protection before inventing new suites: `tests/gateway/generic-harness-model-catalog.test.ts`, `generic-native-profile-observation.test.ts`, `pi-provider.test.ts`, `app-ai-pi-sdk.test.ts`, `app-ai-pi-sdk-real.test.ts`, `bots/route-resolver.test.ts`, `heartbeat/runner.test.ts`, `tests/shell/self-host-shell-mode.test.ts`, `tests/scripts/self-host-installer.test.ts`, and mobile storage/client/auth suites. Required qualification lanes must fail when the real server/model/device is missing, rather than report success by skipping.

## Fault scenarios and release gates

1. **Cold independence:** empty client/browser profile and fresh runtime, public DNS/network blocked before first boot. Login, selected model discovery, first Chat and restart must finish using internal dependencies only.
2. **Route integrity:** stale model catalog, endpoint policy change, credential replacement/revocation and provider outage cannot change payer/account/endpoint or trigger a cloud fallback.
3. **Confinement:** adversarial prompt or malformed model tool call cannot read/write a sibling owner, administrator credential, system unit, database socket or arbitrary LAN resource.
4. **Cancellation and recovery:** client disconnect, gateway restart, model-server loss and cancelled stream produce accurate outcomes; uncertain effects are not replayed as new writes.
5. **Resource exhaustion:** slow/oversized response, excessive tool calls and concurrent users respect existing queues, byte/token bounds, timeouts and shutdown drains. Hardware/model admission requires measured context/concurrency limits.
6. **Identity:** internal user A cannot impersonate user B or reuse stale membership/session proof. Commercial license failure cannot broaden authorization or prevent owner data recovery.
7. **Surface proof:** web desktop, web mobile, Electron and native iOS/Android require separate running-surface qualification for affected flows. Architecturally excluded surfaces need explicit reviewer-approved scope, not inferred parity.
8. **Hosted coexistence:** the same shared-core change passes existing hosted auth/provider/funding tests and the new local profile lane. Hosted and standalone configurations must not leak credentials or silently select each other's services.

## Unresolved decisions requiring evidence

- Which exact open-weight models and inference server meet required tool/vision/context quality and throughput? No benchmark or hardware sizing was performed in this assessment.
- Is read-only local Chat an acceptable first milestone, or must initial acceptance include app creation? The production support claim must match that answer.
- Which OS/CPU/GPU baseline, internal CA/mTLS policy and model-weight distribution method will be supported first?
- Which organization collaboration/native-client features are mandatory for the first release, and which are explicitly phased?
- Which native harness credentials/configuration representations reliably admit keyless internal servers without pretending cloud authentication? Requires exact-version spike.
- Which background helper callers can be retired, and which need the shared local executor? Call-site inventory must be completed before removing Claude-oriented code.

These unknowns are spike/product decisions; none is evidence that the current product is air-gap ready.
