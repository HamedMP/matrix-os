# WhatsApp connection settings and Chat handoff

## User behavior

Settings → Messaging exposes WhatsApp on Web Canvas, Web Desktop, Electron
Desktop and Web Mobile. Native Mobile follows separately in #2374 / ENG-372. Connection status describes the
owner's current WhatsApp consent, separately from the main computer's AI
readiness. It never claims an AI account is ready based on a messaging link.
Web Mobile uses a full-screen Settings list with Back navigation.

New, unbound WhatsApp Chats use Matrix AI Gateway's `matrix_pi_default` system
agent from the live catalog. Its funded route and model must be ready; an
unavailable Gateway route does not silently fall back to Hermes or another
Matrix Pi account. Existing saved
agent selections, immutable provider bindings and in-flight admission receipts
remain authoritative. A provider binding cannot be rewritten in place. An
explicitly authorized migration creates a fresh owner Chat with the Gateway
selection and rebinds the same WhatsApp connection through the existing
transactional compare-and-swap path only while its queue is idle. The previous
Chat and history remain intact; other customers are not migrated implicitly.

A failed WhatsApp run sends one link to its private Matrix Chat. The link opens
Native Mobile on an installed iOS build with the association entitlement; the
browser fallback remains available. Both pass through normal authentication
and computer readiness checks. A WhatsApp Chat belongs to the main computer:
Web explicitly selects `primary`; Native selects the verified owner's available
main customer computer before opening the Chat. References grant no access.
The Web continuation resolves the authenticated owner's running primary customer
computer and redirects to its explicit `/vm/<handle>` route before loading Chat.
An existing session for an additional computer cannot capture the handoff;
missing or unavailable main computers fail closed. Ordinary API requests retain
their existing signed-session runtime authority.

## Sources of truth and security

| Route                                         | Access                                                 | Source of truth                                                  |
| --------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| GET `/api/whatsapp/settings`                  | Verified Clerk session or signed Matrix device session | Owner's active consent record; server admission configuration    |
| GET `/open?chat=...`                          | Public navigation page                                 | Bounded canonical Chat reference; normal auth required afterward |
| GET `/.well-known/apple-app-site-association` | Public static association                              | Existing app team and bundle identifiers; `/open` only           |
| Existing connect/claim/confirm/delete routes  | Existing Clerk and exact Origin checks                 | Consent/link repositories; unchanged by this extension           |

Only masked account information reaches Settings. No sign-in token, account-link
permit or provider diagnostic enters the handoff URL. Unknown/duplicate query
parameters fail closed. Responses with owner information are not cached.
Loading, failures and account switches clear stale connection actions. Returning
from the browser refreshes status; browser requests do not overlap. External
requests retain bounded timeouts. There are no new persistence writes or orphan
states. Linking mutations retain their own transaction and admission policy.

## Validation and rollout

- Test owner isolation, disabled service, invalid consent and repository failure.
- Test one attention URL, sign-in continuation and primary-computer selection.
- Exercise shared settings loading/connected/error states and Web Mobile navigation.
- Run platform/Electron typecheck, production shell build and pattern checks.
- Qualify the new iOS binary on a physical device before removing draft status.
- Configure the optional public `WHATSAPP_BUSINESS_PHONE_NUMBER` (digits only)
  to expose Open WhatsApp; deployment validation does not change admission.
- Deploy platform routes and association first, then the reviewed host bundle and
  mobile build. Existing installed mobile binaries cannot gain entitlements OTA.
- Publish a separate customer-facing documentation PR in `FinnaAI/matrix-os-site`
  covering Settings → Messaging, connection, example prompts and attention recovery.

## Platform limitations and deferred scope

Android can use the explicit Matrix-app button after updating to a build with the
`/open` route. Verified automatic Android App Links need the production signing
certificate association and are deferred until that certificate is verified.
WhatsApp one-time account-link tokens remain in the secure browser flow.
The broader Web Mobile launcher and Chat navigation redesign is a separate
follow-up; this change aligns Settings and messaging behavior.

Follow-up: [Web Mobile navigation and verified Android handoff](https://github.com/HamedMP/matrix-os/issues/2372).
# Operator authority for Messaging entry actions

Settings connection/install links use one operator-configured platform app
origin, with the production default preserved. Web reads explicit
`NEXT_PUBLIC_MATRIX_APP_URL`; Electron uses the main-owned authenticated profile
from `OPERATOR_GATEWAY_URL`; Native uses `EXPO_PUBLIC_MATRIX_APP_URL` for both
links and hosted requests/WebSockets. Selected computers, API payloads and URL
query parameters cannot select this authority. Invalid explicit configuration
fails closed. Development-only exact loopback HTTP/ports are supported.
Native nonproduction runtime/Chat persistence is origin-scoped without changing
production keys or Clerk credentials. In-app Native Chat navigation stays local
and continues to select the owner's primary computer. Public setup documentation
must be updated in the existing companion site documentation PR before release.

## Independent WhatsApp release

PR #2373 targets main independently of Slack installer PR #2275. Only shared
operator-origin validation is reused; no Slack installer, Slack auth return,
Slack pilot routing or Slack permissions change ships in this layer. Existing
Connect Apps behavior stays on main. The Slack branch and PR are preserved.

ENG-124 tracks live WhatsApp qualification; ENG-372 tracks native-device work.
Hamed approved this separation and optional test Clerk membership on November 13,
2026, and waived recordings on November 12. Attach current-head screenshots for
Web Canvas, Web Desktop, Web Mobile and Electron Desktop, with QA fixture limits,
before merge. Publish Canary after merge and same-SHA CI; promote Stable only
after verification of the exact released bundle. Public docs: site PR #214.

The Slack-only nested-heading assertion is excluded with SlackInstallPanel,
which is absent from this release. Its original implementation and test remain
in the preserved pre-split history; all WhatsApp state/recovery assertions remain.
