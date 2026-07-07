# Task 11 — Messages page edit

**Status**: DONE

## Changes made

- Added `import { Card, Cards }` (was missing; page now uses Cards for the supported networks section).
- Added cross-links to `/docs/hermes` in the opening sentence and in the new "Hermes and Messages" section.
- Replaced the flat bullet list under "What You Can Connect" with a `<Cards>` block that describes the two networks accurately: Telegram uses API-credential setup; WhatsApp uses QR pairing (confirmed in `bridge-accounts.ts` `MESSAGING_NETWORKS`).
- Restructured the Privacy Model section to reflect the actual permission schema fields: `readEnabled`, `replyEnabled`, `automationEnabled`, `mentionOnly`. The original page called mention-only a separate "access mode" alongside read/reply/automation; in code it is a modifier flag on read access, not its own level.
- Added a "Hermes and Messages" section listing the four concrete work-item kinds from the code (`summarize`, `classify`, `draft_reply`, `automation`) so users understand what granting each permission enables.
- Added a `<Callout type="warn">` explaining that Hermes requires Claude credentials, mirroring the pattern used in `hermes.mdx` and cross-linking to that page.
- Added an "Automations" section documenting triggers (text match) and actions (create_task, draft_reply), and clarifying the approval fallback when reply permission is absent — all sourced from `schemas.ts`.
- Kept the Recovery section and production-status Callout; tightened wording and added the QR/relink detail for WhatsApp (matches `WHATSAPP_RELINK_AFTER_STALE_RESTORE_MS` constant).
- All headings use sentence case; no emojis; no `/docs/users/*` links.

## Channels actually supported per code

Source: `packages/gateway/src/messages/bridge-accounts.ts` and `schemas.ts`.

| Network | Setup kind | Enabled |
|---------|------------|---------|
| Telegram | `api_credentials` | true |
| WhatsApp | `qr` | true |

No other networks are registered. Spec 077 mentions Signal, Discord, and Slack as future scope, but they are explicitly excluded from the first implementation.

## Uncertainties

- Whether the Messages app is visible to end users yet (the production-status Callout says it is still a validation gate, so the deferred-feature language is appropriate).
- The "mention-only" UX label: in code the field is `mentionOnly` on the permission record, but the product copy in the old page called it "mention-only mode." The edit keeps that label but correctly positions it as a modifier on read access rather than a standalone mode.
- Automation scope values `network` and `account` exist in the schema enum but are blocked at the create-request layer (`refine` check). The edit omits them from user-facing docs to avoid confusion.
