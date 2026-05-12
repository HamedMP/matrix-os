# Messages Gateway Module

Owner-scoped Matrix messaging bridge routes and services live here.

This module is intentionally separate from `packages/gateway/src/channels/`.
`channels` is the legacy direct-adapter namespace; `messages` is the
Matrix-room-backed messaging backbone for Telegram, WhatsApp, Hermes
permissions, drafts, automations, and bridge health.
