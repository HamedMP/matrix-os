import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEng85AgentThroughSetup } from "./bots/eng85-agent-journey-support.js";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import type { SlackThreadContextEnvelope } from "@matrix-os/contracts/slack-bridge";
import { createSlackApp } from "../../packages/platform/src/slack/wiring.js";
import type { SlackDatabase } from "../../packages/platform/src/slack/database.js";
import { encryptSlackToken } from "../../packages/platform/src/slack/security.js";
import { createSlackHomeTransport } from "../../packages/platform/src/slack-home-transport.js";
import { createSlackOwnerClient } from "../../packages/gateway/src/startup/slack-owner-client.js";
import { registerOwnerSlack } from "../../packages/gateway/src/startup/slack-owner.js";
import { resolveSlackPlatform } from "../../packages/gateway/src/startup/slack-platform.js";
import { composeManagedCustomDefinition } from "../../packages/gateway/src/bots/custom-definition.js";
import { createPrivateSlackThreadContext } from "../../packages/gateway/src/slack/private-thread-context.js";
import { createSlackMentionSummaries } from "../../packages/gateway/src/slack/mention-summary.js";
import { createRealBotStateDatabase, insertChat } from "./bots/bot-state-support.js";
import { summaryRuntime } from "./slack-summary-runtime-support.js";
import { ownerRuleHarness } from "./slack-rule-tools-support.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse())
    await close(); });
it.each([
    { trigger: "new_message", dev: false },
    { trigger: "owner_mention", dev: false },
    { trigger: "new_message", dev: true },
] as const)("owner Chat rule $trigger (Dev=$dev) drives signed ingress into one English private zero-tool summary", async ({ trigger, dev }) => {
    const fixture = await createRealBotStateDatabase();
    cleanup.push(fixture.destroy);
    const ownerId = "user_rules", runtimeId = dev ? "a1234567-1234-4123-8123-123456789abc" : "preview_runtime";
    let createdAgent: Awaited<ReturnType<typeof createEng85AgentThroughSetup>> | undefined;
    if (trigger === "new_message") {
        const homePath = await mkdtemp(join(tmpdir(), "eng85-slack-agent-"));
        cleanup.push(() => rm(homePath, { recursive: true, force: true }));
        createdAgent = await createEng85AgentThroughSetup({ fixture, ownerId, homePath, withoutIntegrations: dev });
        expect(createdAgent.ownerId).toBe(ownerId);
        cleanup.push(createdAgent.close);
    }
    const botId = createdAgent?.agentId ?? "bot_12345678";
    const chatId = createdAgent?.chatId ?? "chat_rules";
    const otherChatId = "chat_unrelated_private";
    const appId = "A123", teamId = "T123", ownerSlackId = "U123", channelId = "C123", organizationId = "org_rules", token = "a".repeat(64);
    const date = new Date(), root = `${Math.floor(date.getTime() / 1000) - 5}.000001`;
    const config = { appId, clientId: "123.456", clientSecret: "c".repeat(32), signingSecret: "s".repeat(32), tokenEncryptionKey: Buffer.alloc(32, 42).toString("base64"), publicBaseUrl: "https://platform.example" };
    if (!createdAgent) {
        await insertChat(fixture.db, chatId, ownerId);
        await fixture.db.insertInto("bot_chat_bindings").values({ owner_id: ownerId, bot_id: botId, chat_id: chatId, kind: "direct", created_at: date, removed_at: null }).execute();
    } else {
        await insertChat(fixture.db, otherChatId, ownerId);
        const created = await fixture.db.selectFrom("bot_operations")
            .select(["bot_id", "chat_id", "owner_id", "status"])
            .where("owner_id", "=", ownerId).where("bot_id", "=", botId).execute();
        expect(created).toEqual([{ bot_id: botId, chat_id: chatId, owner_id: ownerId, status: "active" }]);
    }
    const grant = { ownerId, botId, chatId, runtimeId, appId, teamId, channelId, organizationId, ownerSlackId, installationGeneration: 1, linkCreatedAt: date.toISOString(), scope: "channel" as const };
    const grantId = createHash("sha256").update(JSON.stringify(grant)).digest("hex");
    const gateway = new Hono(), home = createSlackHomeTransport({ fetchImpl: async (url, init) => gateway.fetch(new Request(url, init)) });
    const api = { conversationInfo: vi.fn(async () => ({ canAccess: true, isExternalShared: false, channelMetadata: { id: channelId, name: "tech" } })), hasChannelMember: vi.fn(async () => true), replies: vi.fn(async () => ({ messages: [{ user: "U456", ts: root, text: "Release risk: deployment checklist is incomplete." }], hasMore: false })), postMessage: vi.fn(), addReaction: vi.fn(), history: vi.fn(), exchangeCode: vi.fn() };
    const handle = dev ? "owner-dev" : "pr-3482";
    const readOnlyDev = dev ? { ownerId, organizationId, ownerSlackId, teamId, channelId, handle, machineId: runtimeId } : undefined;
    const dispatchContext = vi.fn(async (envelope: SlackThreadContextEnvelope) => {
        await home({ ownerId, token, origin: "https://gateway.example" }, "context", envelope);
    });
    const platform = await createSlackApp({ db: fixture.db as unknown as Kysely<SlackDatabase>, config, api, startCleanup: false, now: () => date, resolveActor: async () => null, requireOrgAdmin: async () => false, isCurrentMember: async () => true, authorizeChannelBinding: async () => false, authorizeReply: async () => true, resolveDestination: async () => ({ ownerId, runtimeId }), authenticateRuntime: async () => ({ ownerId, runtimeId }), contextGrant: grant, dispatch: vi.fn(), dispatchContext, readOnlyDev });
    cleanup.push(platform.close);
    await platform.repository.saveInstallation({ appId, teamId, organizationId, installedBy: ownerId, botUserId: "UBOT", encryptedBotToken: encryptSlackToken("xoxb-synthetic", config.tokenEncryptionKey, `${appId}:${teamId}`) });
    await platform.repository.createChallenge({ hash: "f".repeat(64), appId, teamId, slackUserId: ownerSlackId });
    await platform.repository.completeLink({ hash: "f".repeat(64), actorId: ownerId, organizationId });
    const client = createSlackOwnerClient({ platformUrl: config.publicBaseUrl, handle, token, fetchImpl: async (url, init) => platform.routes.fetch(new Request(url, init)) });
    const summaries = await createSlackMentionSummaries({ db: fixture.db, ownerId, runtimeId, authorize: client.readThreadContextAccess, readThread: client.readSummaryThread });
    cleanup.push(summaries.close);
    let swapEnrollment = false;
    const context = await createPrivateSlackThreadContext({ db: fixture.db, ownerId, runtimeId, authorize: client.readThreadContextAccess,
        async discoverEnrollment(target, signal) {
            const enrollment = await client.discoverThreadEnrollment(target, signal);
            return swapEnrollment && enrollment.available ? { ...enrollment, access: { ...enrollment.access, chatId: otherChatId } } : enrollment;
        }, onReceive: summaries.receive });
    const connection = dev ? resolveSlackPlatform({
        MATRIX_RUNTIME_SLOT: "dev", MATRIX_HANDLE: handle, MATRIX_MACHINE_ID: runtimeId, MATRIX_USER_ID: ownerId,
        MATRIX_SLACK_PLATFORM_URL: "https://slack-dev-a1234567---matrix-platform-preview-fixture-ey.a.run.app", MATRIX_SLACK_PLATFORM_TOKEN: token,
        MATRIX_SLACK_DEV_TARGET: JSON.stringify({ ownerId, machineId: runtimeId, handle, appId, teamId, channelId, botId, chatId }),
    }).connection : undefined;
    if (dev) expect(connection?.devTarget).toMatchObject({ ownerId, chatId, channelId });
    const bridge = registerOwnerSlack({ app: gateway, ownerId, token, devTarget: connection?.devTarget, context, summaries, startDrain: false, authority: { authorize: async () => { throw Error("No collaboration"); } } });
    cleanup.push(bridge.close);
    const push = async (eventId: string, ts: string, text: string, origin = { appId, channelId }) => { const body = JSON.stringify({ type: "event_callback", api_app_id: origin.appId, team_id: teamId, event_id: eventId, event: { type: "message", channel_type: "channel", channel: origin.channelId, user: "U456", thread_ts: root, ts, text } }); const timestamp = String(Math.floor(date.getTime() / 1000)); const signature = createHmac("sha256", config.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex"); return platform.routes.request("/webhooks/slack/events", { method: "POST", body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${signature}` } }); };
    expect(Number((await sql<{count:string}>`SELECT count(*) AS count FROM slack_private_thread_context`.execute(fixture.db)).rows[0]!.count)).toBe(0);
    let policyTime = date.getTime() - 1_000;
    const harness = await ownerRuleHarness({ fixture, enrollment: { access: { ownerId, botId, chatId, runtimeId, grantId }, appId, teamId, channel: { id: channelId, name: "tech" } }, context, now: () => new Date(policyTime) });
    const instruction = trigger === "new_message" ? "From now on summarize every new message in #tech immediately in English, focusing on release risks. Do not reply in Slack." : "Whenever teammates mention me in #tech, summarize immediately in English, focus on release risks. Do not reply in Slack.";
    const binding = await harness.turn(instruction);
    if (dev) {
        const saved = (await createdAgent!.agents.get({ type: "personal", ownerId }, botId))!;
        expect(saved.recipe?.integrations).toEqual([]);
        expect((await composeManagedCustomDefinition(saved, createdAgent!.customRecipes)).capabilities).not.toContain("integration.inventory");
        swapEnrollment = true;
        expect(await harness.call(binding, { operation: "list" })).toEqual({ rules: [] });
        swapEnrollment = false;
        const other = await ownerRuleHarness({ fixture, enrollment: { access: { ownerId, botId, chatId: otherChatId, runtimeId, grantId },
            appId, teamId, channel: { id: channelId, name: "tech" } }, context });
        expect(await other.call(await other.turn("List my Slack rules."), { operation: "list" })).toEqual({ saved: false, reason: "invalid_input" });
        await other.finish();
    }
    const discovered = await harness.call(binding, { operation: "list" });
    expect(discovered).toEqual({ rules: [], enrolledSource: { sourceId: harness.sourceId, label: "#tech" } });
    const receipt = await harness.call(binding, { operation: "create", sourceId: discovered.enrolledSource.sourceId, ownerInstruction: instruction, definition: { trigger, cadence: { kind: "immediate" }, focus: "release risks", language: "English" } });
    expect(receipt).toMatchObject({ saved: true, receipt: { language: "English", state: "active" } });
    await harness.finish();
    const reply = "Summary: The deployment checklist is incomplete.\nSuggested to-dos:\n- [ ] Review the deployment checklist.\nSource: #tech; current thread only.";
    const runtime = await summaryRuntime(fixture.db, summaries, ownerId, botId, reply, createdAgent);
    cleanup.push(runtime.close);
    const ts = `${Math.floor(date.getTime() / 1000)}.000001`, text = trigger === "new_message" ? "An ordinary release update without any mention" : "<@U123> please review the release risk";
    if (dev) {
        expect((await push("EvWrongChannel", ts, text, { appId, channelId: "C456" })).status).toBe(200);
        expect((await push("EvWrongApp", ts, text, { appId: "A456", channelId })).status).toBe(403);
        expect(dispatchContext).not.toHaveBeenCalled();
    }
    if (trigger === "owner_mention") {
        expect((await push("EvPlain", ts, "Ordinary context, no trigger")).status).toBe(200);
        await summaries.drain();
        expect(runtime.modelRequests).toHaveLength(0);
    }
    const triggerTs = `${Math.floor(date.getTime() / 1000)}.000002`;
    expect((await push("EvTrigger", triggerTs, text)).status).toBe(200);
    expect((await push("EvTrigger", triggerTs, text)).status).toBe(200);
    expect((await push("EvSameTimestamp", triggerTs, text)).status).toBe(200);
    await summaries.drain();
    await expect.poll(() => runtime.modelRequests.length, { timeout: 10_000 }).toBe(1);
    const delivery = () => sql<{
        agent_id: string; chat_id: string; event_id: string; rule_id: string;
        job_id: string; run_id: string; message_id: string; result: string;
    }>`
        SELECT rule.bot_id AS agent_id, message.chat_id, event.event_id, rule.rule_id, job.id AS job_id,
               run.id AS run_id, message.id AS message_id, message.search_text AS result
        FROM slack_mention_summary_jobs job
        JOIN slack_summary_rules rule ON rule.owner_id = job.owner_id AND rule.bot_id = job.bot_id
          AND rule.chat_id = job.chat_id AND rule.rule_id = job.policy->>'ruleId'
        JOIN slack_summary_rule_events event ON event.owner_id = rule.owner_id AND event.rule_id = rule.rule_id
          AND event.revision = (job.policy->>'revision')::bigint AND event.event_id = job.sources->0->>'eventId'
        JOIN chat_runs run ON run.chat_id = job.chat_id AND run.client_request_id = job.request_id
        JOIN chat_messages message ON message.run_id = run.id AND message.chat_id = run.chat_id
        WHERE run.status = 'completed' AND message.role = 'assistant' AND message.state = 'committed'
    `.execute(fixture.db).then(result => result.rows);
    const expectedDelivery = [{
        agent_id: botId, chat_id: chatId, event_id: "EvTrigger", rule_id: receipt.receipt.ruleId,
        job_id: expect.stringMatching(/^req_slack_summary_/), run_id: expect.stringMatching(/^run_/),
        message_id: expect.stringMatching(/^msg_/), result: reply,
    }];
    await expect.poll(delivery, { timeout: 10_000 }).toEqual(expectedDelivery);
    if (trigger === "new_message") {
        const change = async (operation: "pause" | "resume", baseRevision: number) => {
            const ownerInstruction = `Please ${operation} my Slack summary rule.`;
            const binding = await harness.turn(ownerInstruction);
            const result = await harness.call(binding, { operation, ownerInstruction, baseRevision, ruleId: receipt.receipt.ruleId });
            expect(result).toMatchObject({ saved: true, receipt: { revision: baseRevision + 1 } });
            await harness.finish();
        };
        policyTime = date.getTime() + 1_000;
        await change("pause", 1);
        const pausedTs = `${Math.floor(date.getTime() / 1000) + 2}.000003`;
        expect((await push("EvPaused", pausedTs, "Update while paused")).status).toBe(200);
        await summaries.drain();
        policyTime += 3_000;
        await change("resume", 2);
        expect((await push("EvDelayed", `${Math.floor(date.getTime() / 1000) + 2}.000004`, "Delayed delivery from the paused interval")).status).toBe(200);
        await summaries.drain();
        const jobs = await sql<{ event_id: string }>`SELECT sources->0->>'eventId' AS event_id FROM slack_mention_summary_jobs`.execute(fixture.db);
        expect(jobs.rows).toEqual([{ event_id: "EvTrigger" }]);
        expect(await delivery()).toEqual(expectedDelivery);
        expect(await fixture.db.selectFrom("chat_messages").select("role").where("chat_id", "=", otherChatId).execute()).toEqual(dev ? [{ role: "user" }] : []);
        expect(await fixture.db.selectFrom("chat_runs").select("status").where("chat_id", "=", otherChatId).execute()).toEqual(dev ? [{ status: "failed" }] : []);
        expect(runtime.modelRequests).toHaveLength(1);
    }
    const actual = JSON.stringify(runtime.modelRequests);
    expect(actual).toContain("Output language: \\\"English\\\"");
    expect(actual).toContain("release risks");
    expect(actual).toContain("deployment checklist");
    expect(actual).toContain(text);
    expect(actual).not.toContain('"proof"');
    expect(runtime.modelRequests[0]!.tools ?? []).toEqual([]);
    expect(runtime.modelRequests[0]!.max_tokens).toBe(2048);
    expect(await fixture.db.selectFrom("bot_agent_sessions").select("bot_id").execute()).toHaveLength(0);
    expect(api.postMessage).not.toHaveBeenCalled();
    expect(api.addReaction).not.toHaveBeenCalled();
    expect(await platform.repository.getReplyDestination({ appId, teamId, eventId: "EvTrigger" })).toBeNull();
    if (dev) {
        await platform.repository.revokeInstallation(appId, teamId);
        const revoked = await harness.turn("List my Slack rules.");
        const result = await harness.call(revoked, { operation: "list" });
        expect(result.rules).toHaveLength(1);
        expect(result).not.toHaveProperty("enrolledSource");
        await harness.finish();
    }
}, 30000);
