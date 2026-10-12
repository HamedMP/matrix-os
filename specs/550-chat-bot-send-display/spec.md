# Chat and Bot send/display repair (ENG-265)

## User outcome
Matrix AI conversations accept supported image/file input in Chat and Bot. Personal Chat shows the actual command, including owner VPS paths and multiline snippets, through execution and replay. Bot replies use the existing structured working UI without a second polling-driven plain-text Working footer.

All three changes belong to one implementation PR and [ENG-265](https://linear.app/matrix-os/issue/ENG-265/fixchat-restore-matrix-ai-attachments-command-details-and-bot-working) in App Gallery launch.

## Existing contracts
- Matrix-owned Pi and managed subscription/API routes retain their distinct identities and funding/source fences. The Matrix AI label does not prove a GPT model uses funded Relay. Do not add a funded GPT route.
- Authoritative owner-local attachment references enter canonical turns; resolve actual bytes within the selected owner's home. Native image transport must feed actual image content, not just filename/path descriptions.
- Existing worker image transport is capped at four PNG/JPEG/WebP images and two MiB per image. Existing upload limits differ; unsupported input must fail predictably before inference and retain the unsent draft.
- Explicitly submitted files are readable only by their authorized owner/Chat/run. Preserve workspace scope, exact run/runtime generation, cancellation, deadlines and bounded state. File data is untrusted content and cannot grant authority. General file submission does not promise universal PDF/Office interpretation.
- PR #1767 is the bounded tool-details baseline. PR #2058 establishes complete VPS paths in authorized private owner Chat. Paths are not credentials. Preserve recognized credential masking and separate shared/non-owner/export projection.
- Command metadata arriving at completion must enrich the same logical tool activity without inventing a new execution or losing terminal outcome. Already discarded historical data cannot be reconstructed.
- Bot task polling is not canonical run-state authority. Remove queued/running transcript-footer duplicates; preserve pending questions, approvals, waits requiring attention and structured canonical progress/duration UI.

## Authorization matrix
| Boundary | Authority | Change |
| --- | --- | --- |
| Existing attachment upload | Current authenticated owner file access | Preserve upload validation and limits |
| Canonical Chat turn | Existing Chat owner/collaboration authorization | Validate selected model and supported input |
| Bot turn | Direct Chat binding plus saved owner bot definition/route | Forward admitted attachments without widening grants |
| Internal image/file broker | Registered owner/Chat/run/runtime generation and live lifetime | Read only admitted inputs; reject stale/cancelled/foreign reads |
| Private command response | Existing authenticated personal-owner Chat on configured owner runtime | Show complete command with credential masking |
| Shared/non-owner/export response | Existing membership/export authorization plus safe projection | Do not expose private command/path/credential details |

No new public unauthenticated endpoint, datastore, broad filesystem mount or execution permission is introduced.

## Acceptance
1. Failing-first tests prove managed capabilities, canonical admission and worker hydration for actual image bytes; file contents are consumed from the exact admitted input in Chat and Bot.
2. Negative tests cover model vision, MIME/count/size, path/symlink escape, metadata mismatch, owner/run/generation and cancellation fences. Text-only sends and funding/source behavior remain intact.
3. Codex path/multiline/completed-only command details render in private Chat and survive reload. Credential masking and shared/non-owner/export protection retain dedicated tests. Validate managed Matrix AI separately.
4. No plain Working footer appears while tasks run or after replies, including stale polling data. Existing structured working UI and actionable requests remain.
5. Exact-head Preview VPS and Electron Desktop verify fresh/subsequent Chat and Bot image semantics and a unique synthetic file marker. Record client, backend, instance/model/access source; fixtures alone are not live provider acceptance.
6. Deliver one PR, then Human Review with a runnable exact-head environment. No primary/fleet rollout or merge is included in this authorization.
