# Jev Inbox Triage on Matrix Pi Bots

Status: implementation; live acceptance pending. Tracking: ENG-118.

## Problem and outcome

The owned Pi Bot launch left two different Inbox implementations. The native Bot catalog has a read-only Inbox proposal recipe, while the verified Jev classifier, additive labeling and full-Inbox batches still execute through a legacy Hermes ChatAgent. A successful legacy demonstration does not qualify the new Pi Bot.

The native `jev-inbox-triage` recipe becomes Jev Inbox Triage: its main reasoning runs in the existing Matrix-owned Pi worker; Gmail and funded Jev operations execute in the authenticated gateway broker. Users do not select or install Hermes, provide a Jev key, or configure a Hermes primary model.

This upgrades the existing Inbox Triage catalog entry under the same recipe ID; it does not add a second Inbox recipe. New creation requests select the current Jev version. Existing Bots pinned to the previous read-only version retain their original behavior and grants; owners create the upgraded Bot and explicitly grant labeling rather than receiving new mailbox authority silently.

## Built-in discovery for every user

The default authenticated recipe catalog advertises exactly one current `jev-inbox-triage` version named **Jev Inbox Triage**. Discovery is independent of Gmail connections, label grants, selected model, funding balance, owner allowlists or personal API keys. The shared Web Canvas, Web Desktop and Electron Desktop recipe panel can find it by “Jev” and open the native Bot setup. Service and funding requirements are checked during setup/execution, never used to hide the recipe. An unavailable catalog remains an explicit unavailable state, not a legacy Hermes fallback.

Existing read-only Inbox Bots continue resolving their saved version without new permissions. New Bots use the Jev version and obtain fresh read-plus-label consent. The label constraint upgrade is migration 7, after the already shipped provider-connections migration 5 and ChatGPT-plan-devices migration 6; released migration identities are unchanged.

## Authority and data flow

- The recipe declares a dedicated `jev.inbox` capability and Gmail `read` plus narrow `label` effects. It does not expose `integration.call`, shell execution, arbitrary Gmail mutation or credential access.
- The account-choice and connection consent disclose the requested effects before granting access: read Inbox and add Jev classification labels; preserve existing labels; no archive, send, delete or mark read. A label grant is distinct from generic integration `write`.
- The gateway derives the account from the owner's exact live Bot grant and active Gmail connection, including expected profile email. Model arguments cannot select an arbitrary account, owner, message payload or classification result.
- Every checkpoint revalidates owner, exact recipe version, Bot revision, selected connection and grant identity/revision/expiry. Revocation or replacement stops subsequent effects. The authority fingerprint also binds receipts and durable batches.
- No legacy permission, binding or batch is silently imported into a native Bot. Existing agents remain available for compatibility; a newly created Pi Bot obtains fresh consent.
- Reuse the existing server-discovered evidence, funded Jev evaluation, deterministic classification policy, label-only execution and Gmail readback. No main-model claims substitute for actual Jev results or confirmed label writes.
- Jev uses the existing Matrix AI Gateway owner funding route. Main-model credentials remain governed by the owned Pi route resolver. No Hermes Python SDK or launch check applies to a Pi run.
- Native task execution is optional. An authenticated shared-runtime reviewer can run an authorized Pi Bot with coordinator tools without accessing the runtime owner's native provider connections. Such a run never advertises `agent.task`. Owner runs with a saved native executor still require fresh admission; revoked or unavailable saved authorization blocks the run instead of silently dropping it.

## Authentication and resource boundaries

No new public endpoint is introduced. Existing boundaries remain authoritative:

| Boundary | Authentication and authorization | Public |
| --- | --- | --- |
| `GET /api/chat-agents/bot-recipes` | Existing authenticated owner route | No |
| `POST /api/chat-agents/instantiate` | Authenticated owner; validated exact recipe reference and body limit | No |
| `POST /api/chats/:chatId/interactions/:interactionId/resolve` | Authenticated chat actor; pending interaction and disclosed effect/account match | No |
| Scope-runtime `bot.tool` request | Private runtime broker binding, generation, capability, owner and live grant revalidated at execution | No |

Readiness and external Gmail/Jev calls retain the existing bounded transports. Processing tool calls have a ten-minute deadline; ordinary tools keep their existing shorter deadline. The adapter caps live runs at 128, expires them after 35 minutes, pauses owned batch work on run cancellation and drains it on shutdown. Classification and additive label effects remain outside database transactions; durable progress and checkpoint writes retain their existing transaction/concurrency guards.

## Batch behavior

The dedicated tool exposes the existing bounded discovery, evidence selection, evaluation, batch start/next/resume/status operations with shared validated contracts. The gateway retains ownership of page cursors, thread IDs, private receipts and classifications. Durable batches survive run boundaries only under the same owner/Bot/account/authority stamp. Pending or uncertain effects are reported as unconfirmed and never blindly replayed. Preserve queued work and existing label invariants; distinguish labeled, no change, review, preview and unconfirmed results.

## Validation and delivery

1. Red/green contract, tool and authorization tests: no grant, old broad write grant, wrong owner/recipe, account ambiguity, profile mismatch, expired/revoked/replaced grant, changed Bot revision and foreign batch/receipt.
2. Worker tool schema and scope-runtime hydration tests. Dedicated capability cannot access generic Gmail writes or broader integrations.
3. Native account consent and authority UI tests across the shared renderers. Old pending choices cannot authorize a newly introduced label effect without disclosure.
4. Production wiring test: dependencies resolve at registration, owner-funded Jev route and exact Gmail transport are retained; missing dependencies fail closed.
5. Current-head CI, exact published Preview bundle, Electron Desktop with a newly instantiated Pi Bot and explicitly granted Gmail account. Show real Jev calls, confirmed label readback, pagination/resume and a successful persisted English conversation. Record exact runtime, app and source versions plus screenshots in ENG-118.

No production channel promotion, fleet rollout or automatic migration is part of this change. Source tests and legacy Hermes success must be reported separately from Pi live acceptance.
