import { z } from "zod/v4";
import { canonicalBoundedText } from "#canonical-chat-primitives";

export const SLACK_RULE_ACTIVITY_LABEL = "Managing Slack summary rules";

/** Rule changes are presented by their committed receipt. Tool activity is progress only. */
export function isSlackRuleActivity(driverKind: string, label: string): boolean {
    return driverKind === "matrix_bot" && label === SLACK_RULE_ACTIVITY_LABEL;
}

export const SlackRuleDefinitionSchema = z.object({
    trigger: z.enum(["new_message", "owner_mention"]),
    cadence: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("immediate") }).strict(),
        z.object({ kind: z.literal("coalesce"), seconds: z.number().int().min(10).max(3600) }).strict(),
    ]),
    focus: canonicalBoundedText(1000, 4000),
    language: z.string().min(2).max(64).regex(/^[\p{L}][\p{L} -]*$/u),
}).strict();
const id = z.string().regex(/^srule_[a-f0-9]{32}$/);
const instruction = canonicalBoundedText(8000, 16000);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const SlackRuleOperationSchema = z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("list") }).strict(),
    z.object({ operation: z.literal("get"), ruleId: id }).strict(),
    z.object({ operation: z.literal("create"), sourceId: z.string().regex(/^slack_enrolled_[a-f0-9]{32}$/), definition: SlackRuleDefinitionSchema, ownerInstruction: instruction }).strict(),
    z.object({ operation: z.literal("update"), ruleId: id, baseRevision: revision, definition: SlackRuleDefinitionSchema, ownerInstruction: instruction }).strict(),
    ...(["pause", "resume", "delete"] as const).map(operation => z.object({ operation: z.literal(operation), ruleId: id, baseRevision: revision, ownerInstruction: instruction }).strict()),
]);
export type SlackRuleDefinition = z.infer<typeof SlackRuleDefinitionSchema>;
export type SlackRuleOperation = z.infer<typeof SlackRuleOperationSchema>;

export const SLACK_RULE_PILOT_LIMITS={currentRulesPerBotEnrollment:1,retainedEnrollmentsPerBot:16,summariesPerUtcDay:25,pending:100,concurrent:1,batchSources:32,groupingScope:"thread"} as const;
