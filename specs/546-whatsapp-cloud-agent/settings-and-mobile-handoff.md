# WhatsApp connection settings and Chat handoff

## User behavior

Settings → Messaging exposes WhatsApp and Slack on Web Canvas, Web Desktop,
Electron Desktop, Web Mobile and Native Mobile. Connection status describes the
owner's current WhatsApp consent, separately from the main computer's AI
readiness. It never claims an AI account is ready based on a messaging link.
Web Mobile uses a full-screen Settings list with Back navigation.

New, unbound WhatsApp Chats use the Matrix-owned Pi agent from the live catalog.
Its exact owner-authorized account or funded access source must be ready; an
unavailable Matrix route does not silently fall back to Hermes. Existing saved
agent selections, immutable provider bindings and in-flight admission receipts
remain authoritative. Owners can change an ordinary Chat's selection in Matrix.

A failed WhatsApp run sends one link to its private Matrix Chat. The link opens
Native Mobile on an installed iOS build with the association entitlement; the
browser fallback remains available. Both pass through normal authentication
and computer readiness checks. A WhatsApp Chat belongs to the main computer:
Web explicitly selects `primary`; Native selects the verified owner's available
main customer computer before opening the Chat. References grant no access.

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
