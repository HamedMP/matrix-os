import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { expect } from "vitest";
import { MATRIX_BOT_INSTANCE_ID, MATRIX_BOT_SELECTION, type SlackRuleOperation } from "@matrix-os/contracts";
import { createRealBotStateDatabase, insertChat } from "./bots/bot-state-support.js";
import { createSlackRuleTools } from "../../packages/gateway/src/slack/rule-tools.js";
import { enrolledSlackSourceId } from "../../packages/gateway/src/slack/enrolled-read-source.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { admitCanonicalTurn } from "../../packages/gateway/src/chat/turn-admission.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import type { BotRuntimeBinding } from "../../packages/gateway/src/bots/runtime-registry.js";
import { createBotTools } from "../../packages/bot-runtime/src/tools.js";
import { createBotToolDispatcher } from "../../packages/gateway/src/bots/tool-dispatcher.js";
import { catalog } from "./chat-orchestrator-test-support.js";
export async function ownerRuleHarness(options?: {
    fixture?: Awaited<ReturnType<typeof createRealBotStateDatabase>>;
    enrollment?: {
        access: {
            ownerId: string;
            botId: string;
            chatId: string;
            runtimeId: string;
            grantId: string;
        };
        appId: string;
        teamId: string;
        channel: {
            id: string;
            name: string;
        };
    };
    context?: Parameters<typeof createSlackRuleTools>[0]["context"];
    now?: () => Date;
}) {
    const f = options?.fixture ?? await createRealBotStateDatabase();
    const { ownerId, botId, chatId, runtimeId } = options?.enrollment?.access ?? { ownerId: "user_rules", botId: "bot_0123456789abcdef", chatId: "chat_rules", runtimeId: "preview_runtime" };
    if (!options?.fixture) {
        await insertChat(f.db, chatId, ownerId);
        await f.db.insertInto("bot_chat_bindings").values({ owner_id: ownerId, bot_id: botId, chat_id: chatId, kind: "direct", created_at: new Date(), removed_at: null }).execute();
    }
    const repository = new ChatRepository(f.db as unknown as Kysely<ChatDatabase>), owner = { type: "personal" as const, ownerId }, principal = { userId: ownerId, source: "jwt" as const };
    const c = catalog();
    c.drivers[0]!.kind = "matrix_bot";
    c.instances[0]!.driverKind = "matrix_bot";
    c.instances[0]!.id = MATRIX_BOT_INSTANCE_ID;
    c.instances[0]!.models[0]!.id = "auto";
    const adapters = new CanonicalChatProviderRegistry([{ driverKind: "matrix_bot", stateSchemaVersion: 1, parseState: v => v, serializeState: v => v, async *start() { throw Error("No model"); } }]);
    const deps = { repository, adapters, catalog: { getCatalog: async () => c }, assertOpen() { }, assertPersonalExecutionAllowed: async () => { }, reconcileActiveRuns: async () => { }, reservePendingDispatch() { }, releasePendingDispatch() { }, atCapacity: () => false, hasStoppingExecution: () => false, startDispatch: async () => { } };
    const service = { ...createCanonicalChatService(repository), admitTurn: (p: never, o: never, id: string, input: never, provenance: never) => admitCanonicalTurn(deps, p, o, id, input, provenance) };
    const routes = createCanonicalChatRoutes({ service: service as never, getPrincipal: () => principal });
    let allowed = true, lastRun: string | undefined;
    const enrollment = options?.enrollment ?? { access: { ownerId, botId, chatId, runtimeId, grantId: "a".repeat(64) }, appId: "A123", teamId: "T123", channel: { id: "C123", name: "tech" } };
    const tools = createSlackRuleTools({ db: f.db, ownerId, runtimeId, context: options?.context ?? { enrollment: async () => allowed ? enrollment : undefined }, now: options?.now });
    const sourceId = enrolledSlackSourceId(enrollment);
    async function turn(text: string, http = true) {
        if (lastRun)
            await repository.finishRun(owner, { chatId, runId: lastRun, outcome: "failed", completedAt: new Date().toISOString() });
        const body = { clientRequestId: `req_${randomUUID().replaceAll("-", "")}`, baseRevision: (await repository.get(owner, chatId))!.chat.revision, parts: [{ type: "text", text }], selection: MATRIX_BOT_SELECTION, interactionMode: "default", permissionMode: "supervised" };
        let accepted;
        if (http) {
            const response = await routes.request(`/api/chats/${chatId}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
            expect(response.status).toBe(202);
            accepted = await response.json();
        }
        else
            accepted = await admitCanonicalTurn(deps, principal, owner, chatId, body as never);
        lastRun = accepted.run.id;
        return { ownerId, botId, chatId, runId: accepted.run.id, taskId: "task_rules", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", rootFingerprint: "f".repeat(64), route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200000, maxOutputTokens: 8192 }, accessSourceId: "matrix_included", capabilities: ["slack.rules"], requestClass: "interactive" } as BotRuntimeBinding;
    }
    const dispatcher = createBotToolDispatcher({ homePath: "/synthetic", slackRules: tools });
    const call = async (binding: BotRuntimeBinding, args: SlackRuleOperation) => {
        const tool = createBotTools({ capabilities: ["slack.rules"], state: { waitingForPerson: false, effectUnknown: false }, broker: { tool: async (request, signal) => (await dispatcher.dispatch(binding, request, signal ?? AbortSignal.timeout(5000))).result } as never })[0]!;
        const result = await tool.execute("call_rule", args, AbortSignal.timeout(5000));
        return JSON.parse(result.content.map(item => item.type === "text" ? item.text : "").join(""));
    };
    return { ...f, repository, owner, tools, sourceId, turn, call, async finish() { if (lastRun) {
            await repository.finishRun(owner, { chatId, runId: lastRun, outcome: "failed", completedAt: new Date().toISOString() });
            lastRun = undefined;
        } }, revoke() { allowed = false; } };
}
