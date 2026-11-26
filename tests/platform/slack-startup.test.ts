import { createHmac } from "node:crypto";
import {describe,it,expect,vi} from "vitest";
import {buildPlatformVerificationToken} from "../../packages/platform/src/platform-token.js";
import {bootstrapPlatformSlack} from "../../packages/platform/src/slack-startup.js";
import {createApp} from "../../packages/platform/src/main.js";
import {Hono} from "hono";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import {stubOrchestrator} from "./proxy-routing-test-utils.js";
import {makeSlackDevCertificate} from "./slack-dev-certificate-fixture.js";
describe("Slack platform startup",()=>{
  it("owns Slack namespaces when the app or organization authority is unavailable",async()=>{
    const slack=await bootstrapPlatformSlack({env:{},db:{} as never,platformSecret:"",platformJwtSecret:""});
    for(const [method,path] of [["POST","/api/slack/install"],["POST","/webhooks/slack/events"],["POST","/internal/slack/replies"],["GET","/slack/link"]]) {
      expect((await slack.routes.request(path,{method})).status).toBe(503);
    }
    await slack.close();
  });
  it("leaves the existing webhook available when the optional preview context grant is malformed", async () => {
    const instance = await KyselyPGlite.create();
    const kysely = new Kysely({ dialect: instance.dialect });
    const signingSecret = "s".repeat(32);
    try {
      const slack = await bootstrapPlatformSlack({
        env: { PLATFORM_PREVIEW: "true", SLACK_PREVIEW_RUNTIME_HANDLE: "pr-3482", SLACK_PREVIEW_THREAD_CONTEXT_GRANT: "{",
          SLACK_APP_ID: "A123", SLACK_CLIENT_ID: "123.456", SLACK_CLIENT_SECRET: "c".repeat(32),
          SLACK_SIGNING_SECRET: signingSecret, SLACK_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString("base64"),
          SLACK_PUBLIC_BASE_URL: "https://platform.example" },
        db: { kysely } as never, collaboration: { organizations: {}, repository: {} } as never,
        platformSecret: "platform-fixture", platformJwtSecret: "jwt-fixture", startCleanup: false,
      });
      try {
        const body = JSON.stringify({ type: "url_verification", challenge: "startup-fixture", api_app_id: "A123" });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const digest = createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex");
        const challenge = await slack.routes.request("/webhooks/slack/events", { method: "POST", body,
          headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${digest}` } });
        expect(challenge.status).toBe(200);
        expect(await challenge.json()).toEqual({ challenge: "startup-fixture" });
        expect((await slack.routes.request("/internal/slack/thread-context/access", { method: "POST" })).status).toBe(404);
      } finally { await slack.close(); }
    } finally { await kysely.destroy(); }
  });
  it("accepts the exact isolated Dev callback hostname and disables an unsafe Dev setup", async () => {
    const instance = await KyselyPGlite.create();
    const kysely = new Kysely({ dialect: instance.dialect });
    const signingSecret = "s".repeat(32);
    const scope = { handle: "owner-dev", machineId: "a1234567-1234-4123-8123-123456789abc",
      ownerId: "user_owner", organizationId: "org_dev", teamId: "T123", channelId: "C123", ownerSlackId: "U123" };
    const host = "https://slack-dev-a1234567---matrix-platform-preview-fixture-ey.a.run.app";
    const ingress = makeSlackDevCertificate();
    const env = { PLATFORM_PREVIEW: "true", SLACK_DEV_ACCEPTANCE: JSON.stringify(scope), SLACK_DEV_BRIDGE_TOKEN: "a".repeat(64),
      SLACK_APP_ID: "A123", SLACK_CLIENT_ID: "123.456", SLACK_CLIENT_SECRET: "c".repeat(32), SLACK_SIGNING_SECRET: signingSecret,
      SLACK_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString("base64"), SLACK_PUBLIC_BASE_URL: host,
      SLACK_DEV_INGRESS_CA_PEM: ingress.cert };
    const body = JSON.stringify({ type: "url_verification", challenge: "dev-fixture", api_app_id: "A123" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex");
    const request = { method: "POST", body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${digest}` } };
    const base = { db: { kysely } as never, devOrganizations: { projection: {}, repository: {} } as never,
      platformSecret: "platform-fixture", platformJwtSecret: "jwt-fixture", startCleanup: false };
    try {
      const dev = await bootstrapPlatformSlack({ ...base, env });
      try {
        expect((await dev.routes.request(host.replace("https:", "http:") + "/webhooks/slack/events", request)).status).toBe(200);
        expect((await dev.routes.request("https://matrix-platform-preview-fixture-ey.a.run.app/webhooks/slack/events", request)).status).toBe(403);
        const composed = new Hono();
        composed.route("/", dev.routes);
        composed.all("*", c => c.json({ fallback: true }));
        expect((await composed.request(host + "/internal/slack/thread-context/access", { method: "POST" })).status).toBe(404);
        expect(await (await composed.request(host + "/health")).json()).toEqual({ fallback: true });
      } finally { await dev.close(); }

      for (const change of [{ SLACK_PUBLIC_BASE_URL: "https://matrix-platform-preview-fixture-ey.a.run.app" },
        { SLACK_PUBLIC_BASE_URL: host.replace("a1234567", "b1234567") }, { SLACK_DEV_THREAD_CONTEXT_GRANT: "{}" },
        { SLACK_DEV_INGRESS_CA_PEM: undefined }, { SLACK_DEV_INGRESS_CA_PEM: "invalid cert" },
        { SLACK_DEV_BRIDGE_TOKEN: buildPlatformVerificationToken(scope.handle, base.platformSecret) }]) {
        const invalid = await bootstrapPlatformSlack({ ...base, env: { ...env, ...change } });
        try { expect((await invalid.routes.request(host + "/webhooks/slack/events", request)).status).toBe(503); }
        finally { await invalid.close(); }
      }

      const grant = { scope: "channel", appId: "A123", teamId: scope.teamId, channelId: scope.channelId,
        ownerId: scope.ownerId, ownerSlackId: scope.ownerSlackId, organizationId: scope.organizationId,
        runtimeId: scope.machineId, botId: "bot_12345678", chatId: "chat_12345678",
        installationGeneration: 1, linkCreatedAt: "2026-11-25T01:00:00.000Z" };
      const executor = { selectFrom: vi.fn(), selectAll: vi.fn(), where: vi.fn(),
        executeTakeFirst: vi.fn().mockResolvedValue({ machine_id: scope.machineId, handle: scope.handle, runtime_slot: "dev",
          provisioning_class: "customer", clerk_user_id: scope.ownerId, public_ipv4: "203.0.113.1", status: "running",
          deleted_at: null, hetzner_server_id: null, recovery_create_action_id: null, recovery_old_server_id: null }) };
      executor.selectFrom.mockReturnValue(executor);
      executor.selectAll.mockReturnValue(executor);
      executor.where.mockReturnValue(executor);
      const enrolledDev = await bootstrapPlatformSlack({ ...base, db: { kysely, executor } as never,
        env: { ...env, SLACK_DEV_THREAD_CONTEXT_GRANT: JSON.stringify(grant) } });
      try {
        const access = (handle: string, authorization: string) => enrolledDev.routes.request(host + "/internal/slack/thread-context/access", {
          method: "POST", headers: { authorization, "x-matrix-handle": handle, "content-type": "application/json" }, body: "{}",
        });
        expect((await access(scope.handle, `Bearer ${buildPlatformVerificationToken(scope.handle, base.platformSecret)}`)).status).toBe(401);
        expect((await access("owner", `Bearer ${env.SLACK_DEV_BRIDGE_TOKEN}`)).status).toBe(401);
        expect((await access(scope.handle, env.SLACK_DEV_BRIDGE_TOKEN)).status).toBe(401);
        expect(executor.selectFrom).not.toHaveBeenCalled();
        expect((await access(scope.handle, `Bearer ${env.SLACK_DEV_BRIDGE_TOKEN}`)).status).toBe(400);
        expect(executor.selectFrom).toHaveBeenCalledWith("user_machines");
        expect(executor.where).toHaveBeenCalledWith("machine_id", "=", scope.machineId);
        executor.executeTakeFirst.mockResolvedValue(undefined);
        expect((await access(scope.handle, `Bearer ${env.SLACK_DEV_BRIDGE_TOKEN}`)).status).toBe(401);
      } finally { await enrolledDev.close(); }
    } finally { ingress.close(); await kysely.destroy(); }
  });

  it("registers Slack account and webhook routes before personal computer routing",async()=>{
    const routes=new Hono();
    for(const path of ["/api/slack/link/complete","/webhooks/slack/events","/internal/slack/replies","/slack/link"])
      routes.all(path,c=>c.json({handled:"slack"}));
    const app=createApp({db:{} as never,orchestrator:stubOrchestrator(),env:{},slackRoutes:routes});
    for(const [method,path] of [["POST","/api/slack/link/complete"],["POST","/webhooks/slack/events"],["POST","/internal/slack/replies"],["GET","/slack/link"]])
      expect(await (await app.request(`https://app.matrix-os.com${path}`,{method})).json()).toEqual({handled:"slack"});
  });
});
