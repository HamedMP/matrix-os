# Pilot attachments and file storage boundary (ENG-355)

The controlled Google pilot refuses model-generated `artifact.write` for every run admitted to that pilot, including an ordinary run before its first Gmail collection. Install `createGooglePilotArtifactWriteFence(registry)` through the dispatcher's private `artifactWrites` dependency only after trusted owner-host pilot admission. Neither a request field, a context marker, a processing envelope, nor an ordinary birth receipt establishes cohort membership. A server must not apply this restriction to unrelated managed users merely because the Google runtime exists.

The dispatcher checks before reading the output body, resolving a workspace, creating directories, or staging bytes; it checks again before publication for other installed admission implementations. The supplied pilot implementation always refuses with the existing generic broker error. It is a prospective capability restriction, not filesystem retention/deletion support. Owner upload, download, export, and inspection routes are unchanged. Pilot file generation remains unavailable until separately reviewed storage supports lineage, retention, and exact deletion. This restriction needs product and live-surface evidence before pilot installation.

## Reachable controlled Gmail surfaces

- All 13 catalog actions have reviewed direct HTTP definitions. `get_message` returns MIME/body/attachment metadata; `get_attachment` returns bounded base64url data. Other reads return mailbox metadata; writes operate on Gmail (plain-text send/draft, labels), not Matrix filesystem storage.
- Managed Pi owner tools call the integration client and return the bounded JSON in memory. They do not call `storeBotGmailAttachment`. Tool-result/assistant/cache/context persistence must still use the separately installed canonical, activity, managed-session and context-copy adapters; this boundary does not replace those.
- Legacy recipe-bot integration tools **do** call `storeBotGmailAttachment`, retaining fixed workspace slots. Those calls lack the qualified managed processing claim and must remain outside the controlled pilot. Do not enable a bypass or claim these existing files have retention coverage.
- Non-Gmail service calls, custom MCP calls, and browser actions from a marked Google context are refused by the separate tool-egress guard. Managed pilot file writes need this additional dispatcher boundary because artifact tools bypass owner-tools dispatch.

## Imports and historical data

Local archive publication and legacy Codex import create separate imported chats, archive/asset records and object-store copies through explicit owner import routes. They do not receive current managed Gmail results automatically and do not acquire a server-created-empty-chat birth. Unknown imported/history data remains blocked from qualified model assembly. Manual import/export is owner-controlled; do not infer origin from text or delete these archives as Gmail copies.

Metadata-only outbox mode prevents new pilot outbox payload projections and delayed replay is metadata-only. Historical rows are unchanged. Admission must establish that every pilot-born chat started under metadata-only mode; any preexisting content-bearing pilot outbox requires separate exact owner/chat cleanup under quiesced admission. There is no safe blanket legacy cleanup based on timestamps or absent markers. Files/artifacts/imports created outside this prospective boundary remain explicitly unqualified, rather than silently declared erased.

## Verification

Focused actual-filesystem dispatcher tests prove refusal before body access/workspace resolution/directory creation/staging, immutable pilot refusal for current/stale/cancelled bindings, cleanup when a different admission rejects at publication, and unchanged ordinary uninstalled writes. Existing managed artifact publication and dispatcher tests cover exclusive publication, staging failure cleanup and legacy behavior. No real Gmail/provider calls, owner file deletion, or deployment is part of this unit.
