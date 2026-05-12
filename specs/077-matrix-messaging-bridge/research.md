# 077 Research Notes: Matrix Messaging Bridge

## Decision: Owner-Controlled Bridges, Not Beeper As Backbone

Matrix OS will use self-hosted bridges on each customer VPS as the durable messaging backbone:

```text
Telegram and WhatsApp first
  -> self-hosted bridges
  -> user's Matrix homeserver
  -> Matrix OS Messages app
  -> Hermes and automations, only where allowed
```

**Rationale**: The user's conversations, permissions, bridge state, and recovery data must live under the Matrix OS owner boundary. Beeper-style bridge management is useful product and operational prior art, but a Beeper-managed homeserver would put core conversation infrastructure outside the user's Matrix OS ownership model.

**Alternatives considered**:

- **Beeper-managed backbone**: rejected for first-party Matrix OS because it conflicts with owner-controlled runtime and storage.
- **Direct Telegram/WhatsApp adapters only**: rejected as the long-term model because it would bypass Matrix room semantics and duplicate permissions across channels.
- **Matrix-first self-hosted bridges**: selected, pending homeserver spike validation.

## Decision: Telegram And WhatsApp First

Telegram and WhatsApp are the first two networks for this feature.

**Rationale**:

- Telegram is the preferred earliest spike because login, appservice registration, simple inbound text, outbound text, room creation, and restart recovery should be quick to prove.
- WhatsApp is required before the feature is considered product-ready because it is more representative of the user promise and more likely to stress pairing, session expiry, media, rate limits, and recovery.
- The permission model must support later Signal, Discord, Slack, Instagram, iMessage, and other networks without expanding the first implementation scope.

**Alternatives considered**:

- **One generic first network**: rejected because it lets planning avoid WhatsApp-specific bridge risk.
- **All networks at once**: rejected because it would create an oversized first PR and dilute the homeserver decision.

## Decision: Homeserver Choice Is A Blocking Spike

The planning phase must not assume the existing Conduit direction is still correct for bridge-heavy personal messaging. Conduit was attractive for lightweight social/federation needs, but private messaging bridges have a different compatibility profile.

Planning must compare:

1. Keep Conduit and prove all required bridge behavior works.
2. Move customer VPS messaging to Synapse if it is the most compatible bridge target.
3. Split roles: keep the existing Matrix OS homeserver path for social/federation while using a bridge-compatible per-user homeserver for private messaging only.

**Rationale**: Application-service registration, bridge namespaces, ghost users, media, encryption behavior, restart recovery, backup/restore, and WhatsApp session survival must be boring before product work starts.

**Alternatives considered**:

- **Keep Conduit by default**: rejected unless the spike proves Telegram and WhatsApp bridge compatibility.
- **Move everything to Synapse immediately**: premature until migration and operational cost are documented.
- **Split homeservers**: viable fallback if social/federation and private bridge workloads need different operational choices.

## Required Spike Matrix

Before implementation tasks are generated, run the same throwaway checks for Telegram and WhatsApp on every homeserver option still under consideration.

| Capability | Telegram | WhatsApp | Required before tasks? |
|------------|----------|----------|-------------------------|
| Appservice registration can be automated | yes | yes | yes |
| Bridge namespace/users work after restart | yes | yes | yes |
| Inbound text creates/updates Matrix rooms | yes | yes | yes |
| Outbound text from Matrix reaches original app | yes | yes | yes |
| Media preview/download path has safe limits | yes | yes | yes |
| Backfill/import can be capped and resumed | yes | yes | yes |
| Bridge DB backup/restore preserves session state | yes | yes | yes |
| Revoked room permissions stop Hermes visibility | yes | yes | yes |

If a homeserver fails any required WhatsApp row, it should not be selected for the first product track unless the plan documents a narrow workaround and an explicit replacement milestone.

## Decision: E2EE Is A Blocking Privacy Spike

Bridged Matrix rooms must not be exposed to Hermes through implicit Matrix E2EE key sharing. The first implementation should prefer Hermes as a Matrix OS event consumer over Hermes as a Matrix room member. If encrypted Matrix rooms are enabled for the first slice, a spike must prove how decrypted content is made available only after current room permission checks.

**Rationale**: Matrix room encryption changes the privacy boundary. A direct room member or bridge bot may receive Megolm keys and room history in ways that outlive Matrix OS room-level permission. Hermes access must be revocable by Matrix OS policy, not by hoping Matrix membership or key state lines up.

**Alternatives considered**:

- **Unencrypted bridged Matrix rooms for first slice**: acceptable only if the user-facing privacy copy is explicit and the owner-controlled VPS threat model is documented.
- **Encrypted rooms with Hermes as member**: rejected unless the spike proves no unwanted history/key exposure and clean revocation.
- **Encrypted rooms with gated decryptor/event consumer**: preferred long-term if the spike proves key scoping, replay protection, and revocation.

## Decision: Hermes Privacy Model Must Be Selected Before Implementation

Planning must choose one model before implementation:

1. **Hermes as Matrix room member**: simplest Matrix-native model, but it may expose membership and room history. The plan must prove revocation and history limits.
2. **Hermes as gated observer**: Matrix OS consumes room events and forwards permitted content to Hermes without room membership. This better matches room-level opt-in, but requires reliable event delivery and idempotency.
3. **Hermes as event consumer only**: Hermes never touches Matrix rooms directly; Matrix OS exposes only sanitized, permitted message payloads and sends replies through a controlled Matrix OS service.

**Rationale**: Room-level privacy cannot be retrofitted after Hermes has room history or direct membership. The default planning bias is the least message/history exposure that still supports reply and mention-only workflows.

**Alternatives considered**:

- **Always invite Hermes to rooms**: simpler, but risky for private history and revocation semantics.
- **Never let Hermes send replies**: privacy-preserving, but it misses the core assistant workflow.
- **Permission-gated event consumer**: preferred unless the spike proves Matrix-native membership can enforce history and revocation cleanly.

## Decision: Synapse Selection Requires Split-Homeserver Or Migration Spike

If Gate 1 proves Synapse is required for Telegram/WhatsApp reliability, the next plan revision must choose one of two paths before implementation tasks:

1. **Split homeserver**: keep the existing Conduit-facing social/federation path and run Synapse only for private bridged messaging.
2. **Migration spike**: prove identity, aliases, federation well-known behavior, Hermes participation, and room record migration from Conduit to Synapse.

**Rationale**: Full Conduit-to-Synapse migration affects public Matrix identities and federation routing. It is too risky to hide behind the bridge implementation tasks.

**Alternatives considered**:

- **Implicit migration during bridge rollout**: rejected because it mixes messaging product work with identity/federation migration.
- **Split homeserver first**: likely safest if Conduit remains adequate for social/federation but not bridge-heavy private messaging.

## Decision: Resource Floor And Numeric Caps

The first planning baseline for Telegram plus WhatsApp bridging is:

- Minimum messaging-enabled customer VPS: 2 vCPU, 4 GiB RAM, 40 GiB disk.
- Recommended if Synapse is selected: 2 vCPU, 6 GiB RAM, 60 GiB disk.
- Smallest-tier behavior: messaging stays disabled, Telegram-only experimental, or prompts for upgrade before WhatsApp/Synapse is enabled.
- Queued events: 10,000 per owner, 2,000 per network, 500 per room.
- Media jobs: 100 concurrent per owner, 10 concurrent per room.
- Idempotency retention: 30 days of canonical Matrix event ids.
- Setup sessions: 10 minute TTL, sweep every 15 minutes.
- Backup RPO/RTO: 1 hour RPO for messaging state and 15 minute RTO after the VPS is reachable. WhatsApp may require relink after restore from a snapshot older than 24 hours or whenever the restored paired-device session is rejected.

**Rationale**: The Matrix OS review rules require explicit Map/Set and queue caps. WhatsApp and Synapse can materially change per-VPS resource requirements, so the user should not be routed into a feature their instance cannot sustain.

**Alternatives considered**:

- **No floor until implementation**: rejected because provisioning and UX need to know whether messaging can be enabled.
- **Support on every existing VPS tier**: rejected unless the spike proves stable operation under the smallest tier.

## Decision: Restore Boundary Is Explicit

The first track promises recovery of Matrix OS permission policy, mappings, audit history, and latest visible conversations from the owner backup. It does not promise WhatsApp will always accept a restored paired-device session.

**Rationale**: WhatsApp sessions can be invalidated outside Matrix OS, and stale backup restore can conflict with the active paired device state. Silent partial recovery would be worse than an explicit relink path.

**Boundary**:

- RPO: 1 hour for homeserver, bridge, Matrix OS permission/audit, and mapping data.
- RTO: 15 minutes after the VPS is reachable and storage is available.
- WhatsApp relink may be required after restoring from a backup older than 24 hours or when the bridge reports the restored session invalid.

## Decision: Duplicate Adapter Reconciliation

For Telegram and WhatsApp, bridged Matrix conversations are the only path Hermes and automations may observe once a connected account has a Matrix bridge mapping. Existing direct channel adapters may remain for legacy notifications or migration, but they must be disabled for AI delivery or marked notification-only for the same owner/network/account.

**Rationale**: Two active ingestion paths for the same external conversation can produce duplicate AI events, duplicate replies, and conflicting permission checks.

**Alternatives considered**:

- **Let both paths run**: rejected because room-level consent cannot be enforced consistently.
- **Delete legacy adapters immediately**: rejected because migration and existing users may need a temporary notification-only mode.

## Evidence

- The mautrix bridge setup docs describe bridges as self-hosted services that require a Matrix homeserver supporting application services and separate databases per unrelated program. A shared Postgres instance is acceptable; sharing the same database is not.
- The mautrix appservice docs describe the key homeserver contract: bridges register as application services, can control a namespace of Matrix users, and receive pushed events from the homeserver.
- The mautrix appservice docs include instructions for Synapse registration through `app_service_config_files` and for Conduit registration through the Conduit admin room. They also note a Conduit-specific caveat for some Python-based bridges.
- Synapse's application service docs describe registration files as first-class homeserver configuration.
- Beeper bridge management is useful prior art for guided bridge lifecycle UX, but Beeper Bridge Manager is not the durable Matrix OS backbone because it targets Beeper-managed homeservers rather than owner-controlled Matrix OS homeservers.

## Source Links

- mautrix bridge setup: https://docs.mau.fi/bridges/go/setup.html?bridge=telegram
- mautrix appservice registration: https://docs.mau.fi/bridges/general/registering-appservices.html
- Synapse application services: https://matrix-org.github.io/synapse/v1.98/application_services.html
- Hermes Matrix messaging: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/matrix
- Beeper bridge manager: https://github.com/beeper/bridge-manager
- Beeper bridge self-hosting: https://developers.beeper.com/bridges/self-hosting
