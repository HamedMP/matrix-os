import { createHmac } from "node:crypto";
import {describe,it,expect} from "vitest";
import {bootstrapPlatformSlack} from "../../packages/platform/src/slack-startup.js";
import {createApp} from "../../packages/platform/src/main.js";
import {Hono} from "hono";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import {stubOrchestrator} from "./proxy-routing-test-utils.js";
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
  it("registers Slack account and webhook routes before personal computer routing",async()=>{
    const routes=new Hono();
    for(const path of ["/api/slack/link/complete","/webhooks/slack/events","/internal/slack/replies","/slack/link"])
      routes.all(path,c=>c.json({handled:"slack"}));
    const app=createApp({db:{} as never,orchestrator:stubOrchestrator(),env:{},slackRoutes:routes});
    for(const [method,path] of [["POST","/api/slack/link/complete"],["POST","/webhooks/slack/events"],["POST","/internal/slack/replies"],["GET","/slack/link"]])
      expect(await (await app.request(`https://app.matrix-os.com${path}`,{method})).json()).toEqual({handled:"slack"});
  });
});
