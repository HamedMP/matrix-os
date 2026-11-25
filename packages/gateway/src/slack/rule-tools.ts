import { createBotCheckpointsRepository } from "../bots/repositories/checkpoints.js";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { SlackRuleOperationSchema, type BotToolResult, type SlackRuleOperation } from "@matrix-os/contracts";
import type { Kysely, Transaction } from "kysely";
import type { OwnerBotDatabase } from "../bots/database.js";
import type { BotRuntimeBinding } from "../bots/runtime-registry.js";
import { BotBrokerActionError } from "../bots/broker-actions.js";
import { createSlackRulesRepository, lockSlackRuleChat, type SlackRuleTarget } from "./rules.js";
import { permitsSlackRuleInstruction } from "./rule-instruction.js";
import { appendSlackRuleReceipt } from "./rule-receipt.js";
import { BotStateError } from "../bots/repositories/shared.js";
import type { PrivateSlackThreadContext } from "./private-thread-context.js";
import { enrolledSlackSourceId } from "./enrolled-read-source.js";
const result = (value: unknown): BotToolResult => ({ ok: true, content: [{ type: "text", text: JSON.stringify(value) }] });
const clarification = () => result({ saved: false, clarification: "In this private Matrix Chat, give a complete standing instruction, for example: From now on summarize every new message in #tech immediately in English, focusing on release risks. Name the enrolled channel, every-new-message or mention-me trigger, immediate or explicit thread grouping duration, report focus and output language. One-shot summaries do not create rules." });
export function createSlackRuleTools(options: {
    db: Kysely<OwnerBotDatabase>;
    ownerId: string;
    runtimeId: string;
    context: Pick<PrivateSlackThreadContext, "enrollment">;
    now?: () => Date;
    afterCommit?(chatId: string): Promise<void>;
}) {
    const repository = createSlackRulesRepository(options.db);
    const now = options.now ?? (() => new Date());
    async function ownerMessage(tx: Transaction<OwnerBotDatabase>, binding: BotRuntimeBinding) {
        const row = await tx.selectFrom("chat_runs as run").innerJoin("chat_turns as turn", "turn.id", "run.turn_id").innerJoin("chat_messages as message", "message.id", "turn.input_message_id")
            .select(["message.id", "message.parts", "turn.owner_http_input", "turn.client_request_id", "run.driver_kind", "run.instance_id"])
            .where("run.id", "=", binding.runId).where("run.chat_id", "=", binding.chatId).where("turn.chat_id", "=", binding.chatId).where("message.chat_id", "=", binding.chatId)
            .where("message.actor_id", "=", binding.ownerId).where("message.role", "=", "user").where("message.state", "=", "committed").executeTakeFirst();
        if (!row?.owner_http_input || row.driver_kind !== "matrix_bot" || row.instance_id !== "matrix_bot_default" || row.client_request_id.startsWith("req_answer_"))
            return undefined;
        const parts = typeof row.parts === "string" ? JSON.parse(row.parts) : row.parts;
        if (!Array.isArray(parts) || !parts.length || parts.some(part => part.type !== "text"))
            return undefined;
        return { id: row.id, text: parts.map(part => part.text).join("\n") };
    }
    return {
        async execute(binding: BotRuntimeBinding, raw: SlackRuleOperation, signal: AbortSignal): Promise<BotToolResult> {
            const args = SlackRuleOperationSchema.parse(raw);
            if (signal.aborted || binding.ownerId !== options.ownerId || binding.group || binding.readonlySummary || binding.requestClass !== "interactive")
                throw new BotBrokerActionError("not_granted");
            const target: SlackRuleTarget = { ownerId: binding.ownerId, botId: binding.botId, chatId: binding.chatId, runtimeId: options.runtimeId };
            const needsEnrollment = ["create", "update", "resume"].includes(args.operation);
            let enrolled = needsEnrollment ? await options.context.enrollment({ ...target, signal }) : undefined;
            if (args.operation === "list") {
                try {
                    enrolled = await options.context.enrollment({ ...target, signal });
                } catch (error: unknown) {
                    if (!signal.aborted) console.warn("[slack-rules] source discovery unavailable", error instanceof Error ? error.name : "UnknownError");
                }
            }
            if (needsEnrollment && !enrolled)
                throw new BotBrokerActionError("not_granted");
            const sourceId = enrolled ? enrolledSlackSourceId(enrolled) : undefined;
            const enrolledLabel = enrolled?.channel.name ? `#${enrolled.channel.name}` : enrolled?.channel.id;
            if (args.operation === "create" && args.sourceId !== sourceId)
                throw new BotBrokerActionError("not_granted");
            let committed=false;
            try {
                const answer = await options.db.transaction().execute(async (tx) => {
                    await lockSlackRuleChat(tx, target);
                    const origin = await ownerMessage(tx, binding);
                    if (!origin)
                        throw new BotBrokerActionError("denied");
                    const rules = await repository.list(target, tx);
                    if (args.operation === "list")
                        return result({ rules, ...(sourceId && enrolledLabel && !signal.aborted ? { enrolledSource: { sourceId, label: enrolledLabel } } : {}) });
                    const existing = args.operation !== "create" ? rules.find(rule => rule.ruleId === args.ruleId) : undefined;
                    if (args.operation === "get")
                        return existing ? result({ rule: existing }) : result({ found: false });
                    if (args.ownerInstruction !== origin.text)
                        return clarification();
                    const imported = await createBotCheckpointsRepository(tx).listForRun({ ownerId: binding.ownerId, runId: binding.runId }, tx);
                    if (imported.some(item => ["integration.call", "artifact.read", "jev.inbox", "mcp.call", "browser.action", "agent.task"].includes(String(item.action.capability))))
                        return result({ saved: false, clarification: "This run already consumed imported content. Repeat the complete standing rule instruction in a fresh message in this private Matrix Chat. No rule was changed." });
                    const label = enrolledLabel ?? existing?.label;
                    const definition = args.operation === "create" || args.operation === "update" ? args.definition : undefined;
                    if (!permitsSlackRuleInstruction(origin.text, args.operation, definition, definition ? label : undefined))
                        return clarification();
                    if (needsEnrollment && existing && (existing.grantId !== enrolled!.access.grantId || existing.sourceId !== sourceId))
                        throw new BotBrokerActionError("not_granted");
                    const argsDigest = createHash("sha256").update(JSON.stringify(args)).digest("hex");
                    const prior = await sql<{
                        args_digest: string;
                        receipt: Record<string, unknown>;
                    }> `SELECT args_digest,receipt FROM slack_summary_rule_intents WHERE owner_id=${target.ownerId} AND message_id=${origin.id}`.execute(tx);
                    if (prior.rows[0]) {
                        const intent = prior.rows[0];
                        const live = rules.find(rule => rule.ruleId === intent.receipt.ruleId);
                        if (intent.args_digest !== argsDigest)
                            return result({ saved: false, reason: "owner_instruction_already_used" });
                        return live?.revision === intent.receipt.revision ? result({ saved: true, replayed: true, receipt: intent.receipt }) : result({ saved: false, superseded: true, current: live });
                    }
                    const at = now().toISOString();
                    const rule = args.operation === "create" ? await repository.save({ ...target, sourceId: sourceId!, grantId: enrolled!.access.grantId, channelId: enrolled!.channel.id, label: label!, definition: args.definition, originMessageId: origin.id, now: at }, tx) : await repository.change(target, { ...args, originMessageId: origin.id, now: at }, tx);
                    const receipt = await appendSlackRuleReceipt(tx, rule, args.operation, at);
                    await sql `INSERT INTO slack_summary_rule_intents(owner_id,message_id,args_digest,receipt) VALUES(${target.ownerId},${origin.id},${argsDigest},${JSON.stringify(receipt)}::jsonb)`.execute(tx);
                    committed=true;
                    return result({ saved: true, receipt });
                });
                try {
                    if(committed)await options.afterCommit?.(binding.chatId);
                }
                catch (error) {
                    console.warn("[slack-rules] committed authority cleanup unavailable", error instanceof Error ? error.name : "UnknownError");
                }
                return answer;
            }
            catch (error) {
                if (error instanceof BotStateError)
                    return result({ saved: false, reason: error.code });
                throw error;
            }
        },
    };
}
export type SlackRuleTools = ReturnType<typeof createSlackRuleTools>;
