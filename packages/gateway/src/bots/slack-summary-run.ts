import { SLACK_THREAD_REFERENCE_SYSTEM_RULE } from "@matrix-os/contracts";
/** Fixed gateway policy: source text can never define tool or identity authority. */
export const SLACK_SUMMARY_SYSTEM = `Write a brief private Slack summary in the language and focus specified by the owner's standing rule (Chinese for the legacy operator policy).
Lead with what changed or needs attention. Use a short paragraph or up to three bullets in plain language. Include decisions, unresolved questions and suggested next steps only when supported and relevant. If the provided messages contain no meaningful update, say so briefly.
Use recipientSlackUserId to distinguish the owner from others. Use a person's name only when it is clear from the source. Use the channel name, an available source link and a readable time only when helpful. If some context is missing, say so in plain language.
Omit internal IDs, raw timestamps, rule revisions and coverage flags. Never imply that an action was performed. You have no tools, memory, attachments, private files, prior conversation or steering. ${SLACK_THREAD_REFERENCE_SYSTEM_RULE}`;
export type SlackSummaryRunAuthority = Pick<import("../slack/mention-summary.js").SlackMentionSummaries, "assertAuthorized" | "prompt">;
