# Changelog: Matrix Messaging Bridge

## 2026-05-13

- Selected Synapse with `mautrix-telegram` and `mautrix-whatsapp` for the first
  Telegram/WhatsApp bridge slice after the live spike.
- Added owner-scoped `/api/messages/*` gateway routes for setup, accounts,
  conversations, permissions, appservice event ingestion, replies, drafts,
  automations, health, and recovery.
- Added the first-party Messages Vite app with account setup, room permission
  controls, pending drafts, and automation rule management.
- Added customer-VPS systemd units plus health, backup, and restore helper
  scripts for the private messaging backbone.
- Documented the resource floor, RPO/RTO, WhatsApp relink boundary, deferred
  protocol scope, and remaining real-network first-loop validation gate.
