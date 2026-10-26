# Attachment steering and acknowledged composer cleanup

User-approved bugfix scope, 2026-10-26. Continue PR2912; no production rollout.

## Design

Managed Chat and Bot share the same provider-neutral Pi worker. Capture submitted uploads with the existing owner/run-bound immutable input reader. Stage additional inputs on that run, with aggregate retained-byte/image/count bounds. File contents remain available only via exact artifact aliases; images use the existing authenticated chunk reader. Extend the steer command with an optional bounded image range, never file paths or base64 in supervisor frames. Worker ACK follows hydration and a final same-run/cancellation check. A definite refusal releases staged bytes; uncertain delivery retains them until run cleanup and never retries automatically. Old workers reject unknown image fields without consuming the canonical queue. Group and isolated restrictions remain.

Only clear submitted composer contents after server acknowledgement. Preserve failed submissions, drafts edited during the request, other conversations and identities. Reproduce the reported residue before selecting a fix. Extract submission bookkeeping rather than adding another responsibility to the large workspace component.

Confirmed offline residue: refreshing the authenticated client object after Queue submission but before its acknowledgement caused the old callback to skip both text and attachment cleanup. Retained signed-in drafts now settle by the unchanged authenticated identity/runtime generation and captured draft revision; local unretained drafts still require the original client. The ordinary success path already cleared correctly. Original Electron observations showed delayed UI refresh, so that observation alone is not attributed to this race or counted as final Queue acceptance.

## Verification sequence

1. RED tests: actual upload bytes and worker native image content; attachment aliases; ACK false, Stop during hydration, wrong owner/generation, cumulative limits, transport uncertainty. Exercise Chat and Bot adapter wiring.
2. GREEN: staged run-input helper, optional protocol range, worker hydration/loop content and shared adapter wiring. Retain source/funding/cancellation protections.
3. Composer regression: signed-in real workspace, delayed upload/ACK, focus/edit and failure races. Fix only the reproduced state transition.
4. Run targeted gateway/runtime/contract/Electron tests and affected TypeScript projects. Existing live results apply only to their recorded source SHA.
5. Build a matching Host/worker and Electron pair, reuse the existing private preview, then perform English full-window Electron QA when GUI is available. No additional VM, shared Relay or production change.
6. Update existing Draft PR evidence. Separate public behavior documentation PR in FinnaAI/matrix-os-site remains a release deliverable; no private incident identifiers in public docs. Human review precedes new formal CI/Greptile requests.

## Authority and lifecycle

No new public endpoint. Broker uses the existing authenticated owner/chat/run/runtime/generation binding and source revalidation. Upload paths are captured without symlink traversal. Collections retain at most the existing eight attachments / 20MiB, four native images and source-specific image byte budget per active run; all are released on Stop/terminal cleanup. A single pending attachment steer per run prevents competing range allocation. No silent truncation of file aliases. Rollback requires a matched prior Host/Electron pair; additive optional image fields fail closed against old workers.
