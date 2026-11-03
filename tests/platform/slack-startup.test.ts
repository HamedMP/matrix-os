import {describe,it,expect} from "vitest";
import {bootstrapPlatformSlack} from "../../packages/platform/src/slack-startup.js";
import {createApp} from "../../packages/platform/src/main.js";
import {Hono} from "hono";
import {stubOrchestrator} from "./proxy-routing-test-utils.js";
describe("Slack platform startup",()=>{
  it("owns Slack namespaces when the app or organization authority is unavailable",async()=>{
    const slack=await bootstrapPlatformSlack({env:{},db:{} as never,platformSecret:"",platformJwtSecret:""});
    for(const [method,path] of [["POST","/api/slack/install"],["POST","/webhooks/slack/events"],["POST","/internal/slack/replies"],["GET","/slack/link"]]) {
      expect((await slack.routes.request(path,{method})).status).toBe(503);
    }
    await slack.close();
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
