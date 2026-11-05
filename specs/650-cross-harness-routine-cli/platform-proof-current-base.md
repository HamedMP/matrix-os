# Current-base Platform routine owner proof

## Problem and source scope

The shared Platform at `0e16ddeea89f1e66a925d5d711f07fa85da25030` lacks the routine-specific owner-decision proof required by the separately installed CLI adapter. A browser can reach a confirmation screen while its decision still lacks the purpose proof accepted by the runtime. This patch supplies that prerequisite; it does not establish successful live approval or routine execution.

Status: the owner approved the signed verified-human provenance adaptation for source and isolated tests on 2026-11-04. The original six exchange/code-renewal negative tests now pass. This source qualification does not authorize shared deployment or establish real owner approval, account access or routine execution.

Reuse Draft #3060 (`bc05edaf0c2216e43e1ac1ecb21fcc26c54a771f`, base `c81c2b42ce605b04ffaa89bba36cb1d5f7403841`) on current main. The proof/header/domain/wire schemas remain compatible with frozen runtime source `9b034162d32d9396d76293156579db9269f70ce9`. The 12 original production paths need one transitive DTO module, `contracts/src/bots/routine-cli.ts`, reused from that frozen source, plus the approved existing `app-session-routes.ts`, `sync-jwt.ts` and `session-routing-identity.ts` adaptations: 16 production paths total. No executor, Gateway, CLI, database migration, dependency or secret is added. Current contracts exports/imports and Clerk verification-key/revocation configuration remain intact.

Deliberate security narrowing from the donor: a freshly verified Clerk token must expose the same owner, a nonblank session ID and a safe positive-integer unexpired verified `exp`. Missing expiry no longer falls back to a fresh 60-second proof. A signed Matrix browser session is eligible only with the stronger marker described below; an older `clerk-browser` label alone is insufficient. The routine proof wire contract, MAC domain and runtime verifier are unchanged.

## Strong browser provenance

The existing Platform JWT gains optional `verified_human_browser: true`. Issuance and verification reject other values and any pairing with generic/device provenance; a marked signed session has a positive-integer expiration. It uses the existing signing key and does not create a persisted grant. Public request bodies, headers, native labels and source capabilities cannot set it.

Only an actual matching Clerk verification satisfying the sid/expiry predicate may initially issue the marker. The identity resolver derives a server-only `verifiedHumanBrowserExpiresAt` from that fresh result or from a verified, unexpired strongly marked signed session. This field is separate from ordinary `sessionExpiresAt`, so fresh Clerk login keeps its existing twelve-hour Matrix routing lifetime. The routine signed-session fast path requires both stronger provenance and the current signed Matrix expiry; independent fresh Clerk-cookie fallback remains available.

App-session exchange and both existing code-domain renewal sites preserve the marker only from trusted evidence. Each issuer uses one checked epoch for freshness, lifetime and JWT issuance. Renewal of an existing signed Matrix session cannot extend its original expiration, including across a second boundary. A source expiring while the code upstream is pending loses stronger provenance. Generic/device exchanges preserve their original credential bytes and do not acquire the marker. Legacy browser sessions still route but do not upgrade themselves through exchange or renewal.

Computer selection remains unchanged and outside the production scope: its newly issued token defaults to no stronger marker. This is a safe downgrade; routine decisions then require independent fresh Clerk fallback or a strong browser exchange. Preserving that marker through Computer selection would require a separately scoped 17th production path.

Policy lives in the focused Clerk-session predicate and routine-proof module. The large routing middleware only wires trusted identity and a single issuance epoch at the existing renewal composition sites. Extract a focused renewal composition module before adding further policy there; that broader entrypoint refactor is outside this bounded port.

## Authority and registration

| Entry | Required authority | Result and limits |
| --- | --- | --- |
| Selected-Computer proxy `POST /api/routine-cli/actions/:challengeId/decision` | Authenticated routing plus independently verified matching Clerk `sid`/expiry, or current signed `clerk-browser` with validated stronger human marker; actual authorized selected machine/owner/slot | Strict decision/digest/request ID; server binds owner, handle, machine, slot and challenge. Body <=4000 bytes, bounded body read and session verification. |
| Canonical Chat `POST /api/chats/:chatId/runs/:runId/approvals/:routineChallengeId` | Same human session and selected-Computer checks | Same routine purpose; existing non-routine approval branches retained. |
| `POST /internal/containers/:handle/routine-actions/verify` | Existing handle-bound Platform transport bearer plus preexisting routine-purpose proof | Strict tuple; exact MAC/domain/digest/expiry; current running, authorized, undeleted owned machine and slot. Body <=4000 bytes; at most eight active verifications. No mint authority. |

The proxy strips caller-supplied routine proof headers. Generic sync/device credentials, native labels, exchanged device cookies, CLI source capabilities and model-reported identity do not create owner consent. A valid Clerk cookie can be independently checked even when a device bearer selects the route. The purpose proof lasts at most 60 seconds and is capped by the verified session expiry. Its MAC uses the existing Platform secret in its own domain; the runtime's derived transport key cannot mint it.

The existing bounded read-only machine lookup now returns `machine_id`. Routine verification registers independently of the separate supervised-browser feature flag. The registration owns and closes only a pool it creates; an injected lookup remains caller-owned. No browser, routine activation, background model or integration permission is enabled by this registration.

## Verification and evidence boundaries

| Check | Required observable result | Qualification boundary |
| --- | --- | --- |
| Base regression | Existing current-main proxy returns no routine-purpose proof for a valid browser session and bound machine | Behavioral Red, not a missing-import/collection failure. |
| Session/proof contract | Genuine verified fixture `sid`/expiry or current strongly marked signed browser session produces the exact purpose tuple; missing/blank/invalid/expired/foreign/device/legacy evidence fails | Local verifier fixtures; no real Clerk account or provider invocation. |
| Actual Platform proxy chain | Real `createApp`, persisted isolated SQL machine rows, explicit/normal routes, header stripping and native/device denial | Downstream runtime fetch is synthetic; no live runtime approval. |
| Registered internal HTTP route | Feature flag off still verifies the right proof; transport, tuple, body, expiry, changed registry, unavailable/closed lookup and pool ownership checks hold | Production Hono registration and bounded SQL lookup use an isolated database fixture. |
| Issuer/renewal boundary | Actual exchange and both code issuers preserve eligible stronger provenance, reject weak upgrade, drop expired evidence and never extend a signed source at a clock boundary | Production issuer/consumer methods with real signed JWTs and isolated request/SQL fixtures. |
| Current-base regressions | Existing Clerk key precedence/revocation, custom MCP/browser approvals, explicit/normal/legacy/preview routing and lookup cleanup remain valid | Source/test qualification only; not complete CI or surface/account acceptance. |
| Local production compilation | Contracts and Platform typechecks/build plus compiled proof/route import resolve the new closure | No service startup, cloud image/deployment or traffic qualification. |

Run the two `tests/platform/routine-cli-owner-*.test.ts` suites, `sync-jwt.test.ts` and the current Clerk, custom MCP, browser approval, machine lookup/pooler, app-session, explicit-VM, runtime-selection, session-routing and preview-origin-routing regressions. Record exact source, commands, pass/fail and any setup failures separately. The registered verifier's eight-active-request cap must reject the ninth blocked request and release admission afterward. Tests exercise the actual registered endpoint; lookup SQL uses KyselyPGlite, not a native/server PostgreSQL pool. Real routine replay, durable challenge state, scheduler, revision controls and cancellation semantics remain in the existing runtime backend.

## Deployment boundary

This task authorizes source reuse and isolated tests. A Draft PR is reviewable output; it is not approval to merge or deploy shared Platform environments. No configuration, traffic, grant or credential change is included.

Both request directions must reach a matching authority before live acceptance: the real owner browser's selected-Computer proxy must mint the purpose proof, and the runtime's startup-fixed `PLATFORM_INTERNAL_URL` must verify that proof against the same real registry/key/owner/machine/slot. A tagged no-traffic candidate alone changes neither direction. A staging service cannot be assumed to own the existing test Computer. The general internal Platform URL also serves other clients and must not be repointed as an approval workaround.

Any shared-environment build/deployment, candidate/tag replacement, registry/key access, routing change, restart, traffic promotion or merge needs a concrete separately reviewed scope and owner confirmation. Preserve the existing test Computer bundle until those prerequisites are approved and verified. Real human approval, canonical Bot execution, pause/resume/archive/history and the requested demo remain subsequent acceptance gates.

Public documentation stays a separate deliverable in `FinnaAI/matrix-os-site` Draft #319 at `b539bc7014b8f41b3d9a73ab7fdc648c2c5d404a`. This patch does not duplicate Nima's capability discovery, documentation MCP or skill work.
