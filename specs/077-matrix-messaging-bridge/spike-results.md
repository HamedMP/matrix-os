# Spike Results: Matrix Messaging Bridge

This ledger records blocking gate outcomes before product implementation. The
first product slice proceeds with Synapse selected for Telegram and WhatsApp,
with remaining network-login, media, restore, and E2EE proof tracked as
implementation validation gates rather than blockers for route/UI scaffolding.

## Current Local Status

- Status: first-slice gate accepted; account-login and message-loop validation
  still pending before production enablement
- Completed locally: inert spike harnesses, fixture helpers, resource-floor
  helper, duplicate-adapter policy test
- Completed on prod VPS spike host: isolated Synapse + Postgres +
  mautrix-telegram + mautrix-whatsapp started on localhost-only ports using the
  attached Hetzner volume for Docker/containerd storage
- Spike runtime paths:
  - Data root: `/mnt/HC_Volume_104683898/matrix-messaging-spike`
  - Element Web client: `127.0.0.1:8625`
  - Synapse client API: `127.0.0.1:8618`
  - Telegram bridge appservice: `127.0.0.1:8620`
  - WhatsApp bridge appservice: `127.0.0.1:8621`
- Focused validation:
  `bun run test tests/deploy/customer-vps/matrix-messaging-conduit-spike.test.ts tests/deploy/customer-vps/matrix-messaging-synapse-spike.test.ts tests/deploy/customer-vps/telegram-bridge-spike.test.ts tests/deploy/customer-vps/whatsapp-bridge-spike.test.ts tests/deploy/customer-vps/messaging-media-backfill-spike.test.ts tests/deploy/customer-vps/messaging-e2ee-spike.test.ts tests/deploy/customer-vps/messaging-restore-spike.test.ts tests/deploy/customer-vps/messaging-resource-floor.test.ts tests/gateway/messages/duplicate-adapter-policy.test.ts`
- Focused validation result: pass in default inert mode; set
  `RUN_MATRIX_MESSAGING_SPIKES=1` to require live spike proof

## Gate 1: Homeserver And Bridge Spike

- Status: accepted for first slice with Synapse
- Candidate homeservers: Conduit, Synapse, split-homeserver
- Required networks: Telegram, WhatsApp
- Live result, 2026-05-13:
  - Synapse 1.152.1 starts against isolated Postgres with `C` collation after
    appservice registrations are installed.
  - Synapse client API responds at `http://127.0.0.1:8618/_matrix/client/versions`.
  - mautrix-whatsapp boots, migrates its separate `whatsapp` database, registers
    `@whatsappbot:matrixos-spike.local`, and receives homeserver appservice
    ping.
  - mautrix-telegram boots, migrates its separate `telegram` database,
    registers `@telegrambot:matrixos-spike.local`, and receives homeserver
    appservice ping. It is using a synthetic API ID/hash only for boot; real
    login still requires real Telegram API credentials.
  - Restart recovery for `matrix-spike-postgres`, `matrix-spike-synapse`,
    `matrix-spike-telegram`, and `matrix-spike-whatsapp` passed at the service
    liveness layer.
  - Element Web boots at `http://127.0.0.1:8625` and is configured to use the
    spike Synapse homeserver at `http://127.0.0.1:8618`.
  - Docker/containerd storage was moved to `/mnt/HC_Volume_104683898` before
    this spike so root disk pressure does not affect image pulls or bridge
    state.
- Harnesses:
  - `tests/deploy/customer-vps/matrix-messaging-conduit-spike.test.ts`
  - `tests/deploy/customer-vps/matrix-messaging-synapse-spike.test.ts`
  - `tests/deploy/customer-vps/telegram-bridge-spike.test.ts`
  - `tests/deploy/customer-vps/whatsapp-bridge-spike.test.ts`
- Live-run env:
  - `RUN_MATRIX_MESSAGING_SPIKES=1`
  - `MATRIX_MESSAGING_CONDUIT_URL`
  - `MATRIX_MESSAGING_CONDUIT_APPSERVICE_TOKEN`
  - `MATRIX_MESSAGING_SYNAPSE_URL`
  - `MATRIX_MESSAGING_SYNAPSE_APPSERVICE_TOKEN`
  - `MATRIX_MESSAGING_HOMESERVER_URL`
  - `MATRIX_MESSAGING_TELEGRAM_BRIDGE_URL`
  - `MATRIX_MESSAGING_WHATSAPP_BRIDGE_URL`
- Decision: select Synapse for the first Telegram and WhatsApp bridge slice.
  Conduit remains deferred; split-homeserver migration is not required for the
  first slice because customer messaging accounts will be created directly on
  Synapse-backed rooms.

## Gate 2: Hermes Privacy Mode And E2EE

- Status: first-slice decision recorded
- Selected mode: Hermes as Matrix OS gated event consumer, not a Matrix room
  member.
- E2EE posture: first-slice bridged rooms are treated as unencrypted private
  rooms for Matrix OS permissions. Hermes receives only owner-local event
  copies after room permission checks. Encrypted-room delivery, key sharing, and
  server-side decryption remain deferred until a dedicated E2EE spike proves the
  semantics.
- Harness: `tests/deploy/customer-vps/messaging-e2ee-spike.test.ts`
- Decision: direct Matrix room membership for Hermes is out of scope.
  Revocation must cancel queued Matrix OS work and recheck permissions before
  sending any reply.

## Gate 3: Owner Storage, Resource Caps, And VPS Floor

- Status: selected for first slice
- Owner storage map:
  - Homeserver state: customer VPS homeserver DB
  - Telegram bridge state: separate Telegram bridge DB/schema
  - WhatsApp bridge state: separate WhatsApp bridge DB/schema
  - Matrix OS permissions, audit, setup sessions, mappings: owner-local
    Postgres
  - Media/cache metadata: owner-local store with explicit backup/delete policy
- Numeric caps:
  - Queued events per owner: 10,000
  - Queued events per network: 2,000
  - Queued events per room: 500
  - Concurrent media jobs per owner: 100
  - Concurrent media jobs per room: 10
  - Idempotency key retention: 30 days
  - Setup session TTL: 10 minutes
  - Setup cleanup sweep: 15 minutes
- Customer VPS floor:
  - Telegram + WhatsApp without Synapse selection: 2 vCPU, 4 GiB RAM, 40 GiB
    disk
  - Synapse-backed Telegram + WhatsApp: 2 vCPU, 6 GiB RAM, 60 GiB disk
  - Below floor: messaging disabled, Telegram-only experimental, or upgrade
    prompt
- Recovery boundary:
  - Messaging backup RPO: 1 hour
  - Messaging restore RTO: 15 minutes after VPS is reachable
  - WhatsApp stale restore relink threshold: snapshot older than 24 hours or
    paired-device session rejected

## Gate 4: Route And Appservice Contract

- Status: drafted
- Contract: `contracts/rest-api.md`
- Decision: proceed with route scaffolding and shared schema/error constants.

## Gate 5: Duplicate Adapter Reconciliation

- Status: selected for first slice
- Policy: bridged Matrix path is authoritative for Hermes and automations once
  a bridge mapping exists; any legacy direct adapter for the same
  owner/network/account is notification-only and cannot deliver content to
  Hermes.
- Harness: `tests/gateway/messages/duplicate-adapter-policy.test.ts`
- Decision: implement Matrix bridge mappings as authoritative. Legacy
  Telegram/WhatsApp direct adapters may remain notification-only for the same
  owner/network/account identity.

## Gate 6: Migration Stance

- Status: selected for first slice
- Decision: no Conduit-to-Synapse migration is required for first slice.
  Provision new messaging accounts on the Synapse-backed private messaging
  homeserver. Existing Conduit state remains outside the first-slice bridge
  migration scope.
