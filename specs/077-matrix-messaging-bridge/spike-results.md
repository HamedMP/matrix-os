# Spike Results: Matrix Messaging Bridge

This ledger records blocking gate outcomes before product implementation. Product
tasks remain blocked until the required Telegram and WhatsApp spikes are run
against real homeserver and bridge services.

## Current Local Status

- Status: partial live infrastructure spike passed; account-login and message
  loop still pending
- Completed locally: inert spike harnesses, fixture helpers, resource-floor
  helper, duplicate-adapter policy test
- Completed on prod VPS spike host: isolated Synapse + Postgres +
  mautrix-telegram + mautrix-whatsapp started on localhost-only ports using the
  attached Hetzner volume for Docker/containerd storage
- Spike runtime paths:
  - Data root: `/mnt/HC_Volume_104683898/matrix-messaging-spike`
  - Synapse client API: `127.0.0.1:8618`
  - Telegram bridge appservice: `127.0.0.1:8620`
  - WhatsApp bridge appservice: `127.0.0.1:8621`
- Focused validation:
  `bun run test tests/deploy/customer-vps/matrix-messaging-conduit-spike.test.ts tests/deploy/customer-vps/matrix-messaging-synapse-spike.test.ts tests/deploy/customer-vps/telegram-bridge-spike.test.ts tests/deploy/customer-vps/whatsapp-bridge-spike.test.ts tests/deploy/customer-vps/messaging-media-backfill-spike.test.ts tests/deploy/customer-vps/messaging-e2ee-spike.test.ts tests/deploy/customer-vps/messaging-restore-spike.test.ts tests/deploy/customer-vps/messaging-resource-floor.test.ts tests/gateway/messages/duplicate-adapter-policy.test.ts`
- Focused validation result: pass in default inert mode; set
  `RUN_MATRIX_MESSAGING_SPIKES=1` to require live spike proof

## Gate 1: Homeserver And Bridge Spike

- Status: partial live spike passed for Synapse appservice registration and
  bridge boot; Telegram/WhatsApp account login, inbound/outbound text, media,
  and backup/restore remain pending
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
- Decision: not selected yet. Conduit remains candidate only if appservice,
  Telegram, WhatsApp, restart, media/backfill, E2EE posture, and restore all
  pass. Synapse or split-homeserver remains the expected fallback if Conduit
  fails any required row.

## Gate 2: Hermes Privacy Mode And E2EE

- Status: pending live E2EE spike
- Preferred default: Hermes as Matrix OS event consumer
- Current policy: Hermes must not receive encrypted-room content until
  key-sharing or decrypted-payload semantics are proven and revocation blocks
  delivery within the required boundary.
- Harness: `tests/deploy/customer-vps/messaging-e2ee-spike.test.ts`
- Decision: not selected yet. Direct Matrix room membership remains out of
  first-slice scope unless explicitly justified by the spike.

## Gate 3: Owner Storage, Resource Caps, And VPS Floor

- Status: provisional caps recorded; live floor still pending
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
- Blocking follow-up: route scaffolding and shared schema/error constants have
  not started because Gate 1 and Gate 2 are still pending live proof.

## Gate 5: Duplicate Adapter Reconciliation

- Status: provisional decision captured in test
- Policy: bridged Matrix path is authoritative for Hermes and automations once
  a bridge mapping exists; any legacy direct adapter for the same
  owner/network/account is notification-only and cannot deliver content to
  Hermes.
- Harness: `tests/gateway/messages/duplicate-adapter-policy.test.ts`
- Blocking follow-up: implement detection against real account identity once
  bridge identity fields are known from Gate 1.

## Gate 6: Migration Stance

- Status: pending Gate 1
- Required if Synapse is selected: split-homeserver decision or migration spike
  before product tasks.
- Current stance: do not design Conduit-to-Synapse migration until the
  homeserver spike either selects Synapse or proves Conduit cannot satisfy the
  Telegram and WhatsApp requirements.
