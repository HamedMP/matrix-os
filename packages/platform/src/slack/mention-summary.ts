import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SlackMentionSummaryRuleSchema, SlackMentionSummarySourceSchema, type SlackMentionSummaryRule, type SlackMentionSummarySource } from "@matrix-os/contracts/slack-bridge";
import type { SlackThreadContextGrant } from "./thread-context.js";

export function slackContextGrantId(grant: SlackThreadContextGrant): string {
  return createHash("sha256").update(JSON.stringify(grant)).digest("hex");
}

export function loadSlackMentionSummaryRule(env: NodeJS.ProcessEnv, grant?: SlackThreadContextGrant, previewHandle?: string): SlackMentionSummaryRule | undefined {
  if (!env.SLACK_PREVIEW_MENTION_SUMMARY_RULE) return undefined;
  try {
    if (!grant || !previewHandle) throw new Error("Preview grant required");
    const rule = SlackMentionSummaryRuleSchema.parse(JSON.parse(env.SLACK_PREVIEW_MENTION_SUMMARY_RULE));
    if (rule.grantId !== slackContextGrantId(grant)) throw new Error("Grant mismatch");
    return rule;
  } catch (error) {
    console.warn("[slack] mention summary configuration unavailable", error instanceof Error ? error.name : "UnknownError");
    return undefined;
  }
}

type Source = Omit<SlackMentionSummarySource, "proof" | "ruleId" | "version">;
export function mentionSourceEligible(grant: SlackThreadContextGrant, rule: SlackMentionSummaryRule, source: Source): boolean {
  return rule.grantId === slackContextGrantId(grant) && source.userId !== grant.ownerSlackId
    && Number(source.ts) * 1000 >= Date.parse(rule.enabledAfter)
    && (grant.scope === "channel" || source.threadTs === grant.threadTs);
}

export function slackMentionSourceProof(secret: string, grant: SlackThreadContextGrant, rule: SlackMentionSummaryRule, source: Source): string {
  return createHmac("sha256", secret).update("matrix-slack-owner-mention-summary-v1\n")
    .update(JSON.stringify([rule.grantId, rule.ruleId, rule.version, rule.enabledAfter, grant.appId, grant.teamId,
      grant.channelId, source.eventId, source.threadTs, source.ts, source.userId])).digest("hex");
}

export function validSlackMentionSource(secret: string, grant: SlackThreadContextGrant, rule: SlackMentionSummaryRule | undefined, value: unknown): boolean {
  const source = SlackMentionSummarySourceSchema.safeParse(value);
  if (!rule || !source.success || source.data.ruleId !== rule.ruleId || source.data.version !== rule.version
    || !mentionSourceEligible(grant, rule, source.data)) return false;
  const expected = slackMentionSourceProof(secret, grant, rule, source.data);
  return timingSafeEqual(Buffer.from(source.data.proof, "hex"), Buffer.from(expected, "hex"));
}
