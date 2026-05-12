# Matrix Messaging Bridge

Matrix OS 077 plans an owner-controlled Matrix messaging backbone for Telegram
and WhatsApp first. The production target is customer-VPS-native host services:
the selected Matrix homeserver, bridge runtimes, owner-local Postgres state,
gateway routes, and the first-party Messages app.

Implementation is blocked on the spike gates recorded in
`specs/077-matrix-messaging-bridge/spike-results.md`.

Key invariants:

- Beeper is prior art only, not the runtime backbone.
- Hermes starts with no room visibility.
- The bridged Matrix path is authoritative for Hermes and automations after a
  connected account has a bridge mapping.
- Messaging state stays in the owner-controlled VPS backup lifecycle.
