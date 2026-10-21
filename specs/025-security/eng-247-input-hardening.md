# ENG-247: bounded input reconciliation

[Ticket](https://linear.app/matrix-os/issue/ENG-247/fix-scan-findings-and-track-remaining-verification) · [PR #2564](https://github.com/HamedMP/matrix-os/pull/2564) · [Security specification](./spec.md)

## Goal and scope

Preserve existing output while replacing repeated input scans with bounded forward
scans. HTML extraction returns untrusted **plain text**, not sanitized HTML.
Generated Chat titles retain Markdown link labels, including escaped brackets and
bracketed destinations. Electron table copying preserves literal backslashes and
pipes as Markdown text. Existing input caps and rendering safeguards still apply.

The implementation owns ten production paths and their ten existing test paths:

| Production path | Contract |
| --- | --- |
| `packages/kernel/src/tools/web-utils.ts` | Recognize complete raw-element boundaries without repeated suffix scans. |
| `packages/gateway/src/social-connectors/index.ts` | Strip complete tags once when projecting external post text. |
| `packages/platform/src/ats-group-mail.ts` | Convert email HTML to plain text, retaining supported line breaks and entities. |
| `packages/ui/src/generated-chat-title.ts` | Derive visible labels without including link destinations. |
| `desktop/src/renderer/src/components/conversation/message.tsx` | Escape backslashes before pipes when copying a rendered table. |
| `packages/clerk-sync/src/index.ts` | Retain handle validation and length limits while trimming separators. |
| `packages/gateway/src/app-publish.ts` | Retain app-slug normalization while trimming separators. |
| `packages/gateway/src/chat/safe-activity-projection.ts` | Normalize display roots without exposing additional paths. |
| `packages/sync-client/src/cli/port-forward.ts` | Preserve gateway URL construction while trimming trailing separators. |
| `packages/sync-client/src/daemon/conflict-resolver.ts` | Preserve safe conflict names and the existing fallback. |

No endpoint, authentication authority, permission, persistence schema, transaction
or background resource is added. HTML fidelity limitations remain tracked in
[#2645](https://github.com/HamedMP/matrix-os/issues/2645).

## Surface acceptance

| Surface | Required live journey |
| --- | --- |
| Web Canvas | Create a synthetic Chat with a Markdown-link prompt; verify its visible title and persisted readback. |
| Web Desktop | Repeat title creation and persisted readback in this presentation. |
| Web Mobile | Repeat title creation and persisted readback through the shared Web Chat state. |
| Electron Desktop | Verify title creation/readback and Copy as Markdown for a rendered table containing literal backslashes and pipes; paste into an unsent draft. |
| Native Mobile | **Proposed N/A, not approved:** its unchanged `canonicalChatTitle` creation path and native message renderer do not execute the changed shared title helper or Electron DOM table-copy component. Canonical history remains readable. Obtain explicit reviewer acknowledgment or capture applicable native readback before merge. |

The earlier Themes/Imports exclusions do not approve this Native Mobile proposal.
Recommend affected product/engineering review of the scope and output examples;
record any requested approval without treating that recommendation as a new gate
beyond the explicit Native Mobile acknowledgment.

## Completion checks

- Preserve malformed-input deadline tests, compatible-output comparisons, title
  edge cases and actual DOM table-copy regressions. Run affected type checks,
  patterns and genuine full CI against the final integrated source. Historical
  or equivalent-source results do not qualify a new integration automatically.
- Verify the exact preview bundle and signed Electron artifact. Save screenshots
  and short recordings separately for every applicable surface, including
  persistence and the changed clipboard escaping case. Automated tests do not
  replace live visual evidence.
- Link the tested source/build, preview and surface-labeled captures in the PR;
  share the same evidence with the ticket/PR links in Slack `#tech` and link its
  permalink back. Obtain current-head review qualification and resolve blockers.
- Review the public documentation in `FinnaAI/matrix-os-site` for the plain-text
  extraction boundary and title/table-copy behavior. Link any required companion
  documentation PR, or record a reviewed no-documentation-change rationale;
  never claim documentation completion from this internal plan alone.

No production deployment, real customer transcript, provider credential or
private operator procedure is required by this specification.
