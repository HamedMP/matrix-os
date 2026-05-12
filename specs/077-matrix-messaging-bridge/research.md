# 077 Research Notes: Matrix Messaging Bridge

## Decision To Validate During Planning

Matrix OS should move toward an owner-controlled Matrix messaging backbone on each customer VPS:

```text
External messaging apps
  -> self-hosted bridges
  -> user's Matrix homeserver
  -> Matrix OS Messages app
  -> Hermes and automations, only where allowed
```

This avoids making Beeper the durable backbone. Beeper-style bridge management can remain useful as prior art, but the product goal is that the user's conversations, permissions, and bridge state live under the user's Matrix OS ownership boundary.

## Current Evidence

- The mautrix bridge setup docs describe bridges as self-hosted services that require a Matrix homeserver supporting application services and separate databases per unrelated program. A shared Postgres instance is acceptable; sharing the same database is not.
- The mautrix appservice docs describe the key homeserver contract: bridges register as application services, can control a namespace of Matrix users, and receive pushed events from the homeserver.
- The mautrix appservice docs include instructions for Synapse registration through `app_service_config_files` and for Conduit registration through the Conduit admin room. They also note a Conduit-specific caveat for some Python-based bridges.
- Synapse's application service docs describe registration files as first-class homeserver configuration.

## Homeserver Question

The planning phase should not assume the existing Conduit direction is still correct for this feature. Conduit was attractive for lightweight social/federation needs, but bridge-heavy personal messaging has a different compatibility profile:

- Application-service registration must be reliable and automatable.
- Bridge namespaces, bot users, media, encryption behavior, and restart recovery must be boring.
- Backups and restores must include homeserver state plus bridge state.
- The stack must support WhatsApp, Telegram, Signal, Discord, and Slack over time.

Planning should compare:

1. Keep Conduit and prove all required bridge behavior works.
2. Move customer VPS messaging to Synapse if it is the most compatible bridge target.
3. Split roles: keep the existing Matrix OS homeserver path for social/federation while using a bridge-compatible per-user homeserver for private messaging only.

The default planning bias should be toward the option with the least bridge-specific risk, even if it is heavier operationally.

## Source Links

- mautrix bridge setup: https://docs.mau.fi/bridges/go/setup.html?bridge=telegram
- mautrix appservice registration: https://docs.mau.fi/bridges/general/registering-appservices.html
- Synapse application services: https://matrix-org.github.io/synapse/v1.98/application_services.html
- Hermes Matrix messaging: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/matrix
