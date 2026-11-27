# Spike results: shared messaging bridge (spec 2701)

Live verification on 2026-11-22 against one real bridge host, built from bundle commit
`a05ea00f6`. Versions: Synapse v1.165.0, mautrix-whatsapp v0.2610.0, mautrix-telegram
v0.2610.0, mautrix-linkedin v0.2609.0, Postgres 18.6, Caddy 2.11.8. The platform and gateway
ran the branch code of this stack.

## Bridge host

- `bootstrap.sh` succeeded on its first run on a fresh Ubuntu 24.04 CPX32 server. TLS was
  issued automatically. `health.sh` reported all six services healthy.
- Without the gate header, the admin API, `/_matrix/client/v3/login`, `/register`,
  federation and every `/bridges/*` path answer 404.
- With the gate header, the admin API answers 200, creating a user answers 201, and
  `m.login.application_service` on device `MATRIXOS_GATEWAY` returns a token.
- An owner token works for `whoami` and `/sync` without the gate header.
- `/register` stays 404 even with the gate header. Appservice ghosts can only be registered
  from inside the Docker network.

## Platform routes

- `POST /session` mints a session with networks `whatsapp`, `telegram` and `linkedin`.
- Login flows offered: WhatsApp `qr`, `phone`; Telegram `phone`, `qr` (the `bot` and
  `manual` flows are filtered out); LinkedIn `cookies`.
- Real first steps:
  - WhatsApp `qr`: `display_and_wait` step `fi.mau.whatsapp.login.qr`. The QR data is a
    `https://wa.me/settings/linked_devices#...` string.
  - Telegram `phone`: `user_input` step `fi.mau.telegram.login.phone_number` with one field
    of the same id (kind `phone`).
  - LinkedIn `cookies`: `user_input` step `fi.mau.linkedin.login.enter_cookies` with the
    fields `fi.mau.linkedin.login.cookie_header`, `fi.mau.linkedin.login.x_li_track` and
    `fi.mau.linkedin.login.x_li_page_instance` (all `secret`, all required) and a help URL.
- Cancel works on all three networks.

## Gateway

Run against a real Postgres and the real homeserver:

- Status reports `ready`. Link start and cancel work.
- With a simulated portal room (a ghost user in the WhatsApp namespace and `m.bridge` state
  with protocol id `whatsapp` and a channel receiver):
  - an invite from a bridge-namespace ghost is accepted automatically;
  - the conversation is created with its name, preview and unread count;
  - messages are listed with the ghost's display name;
  - a send returns an event id with delivery `sent`; repeating the same `clientTxnId`
    returns the same event, and the sync echo does not duplicate it.
- Reconciliation marks an account the bridge does not know as `needs_relink`.
- Room ids on this homeserver use the newer server-less form (`!<opaque>`, no `:server`).
  `MatrixRoomIdSchema` accepts it, and a contract test keeps it that way.

## Not yet verified

These need a real phone or account:

- completing a real link;
- real portal creation and history at link time;
- double puppeting of messages sent from the phone;
- real Telegram API credentials (the host runs with placeholder credentials);
- two gateway processes on one database.
