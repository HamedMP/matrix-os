import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createAppCapabilityRoutes } from "../../../packages/gateway/src/app-capabilities/routes";
import { createBotIntegrationClient } from "../../../packages/gateway/src/bots/integration-client";
import { invalidateAppIndexCache } from "../../../packages/gateway/src/app-runtime/app-index";
let home: string;
let owner: string;
const calls: Array<{ owner: string; path: string; body?: Record<string, unknown> }> = [];
const transport = vi.fn(async (id, request) => {
  calls.push({ owner: id, path: request.path, body: request.body });
  if (request.path === "/") return Response.json([{ id: "conn_work", service: "google_drive", account_label: "Work", status: "active" }]);
  if (request.path === "/agent-catalog") return Response.json([{ id: "google_drive", actions: {
    list_files: { description: "List Drive files", risk: "read", params: { maxResults: { type: "number" } } },
    read_file: { description: "Read file", risk: "read", params: { fileId: { type: "string", required: true } } },
    share_file: { description: "Share file", risk: "write", params: { fileId: { type: "string", required: true }, email: { type: "string", required: true } } },
  } }]);
  return Response.json({ data: { files: [{ id: "doc1", name: "Notes" }] } });
});
beforeEach(async () => { home=await mkdtemp(join(tmpdir(),"app-capability-")); await Promise.all([mkdir(join(home,"system")),mkdir(join(home,"apps"))]); owner="owner"; calls.length=0; transport.mockClear(); });
afterEach(async () => { await rm(home,{recursive:true,force:true}); });
async function grant() { await writeFile(join(home,"system/app-capabilities.json"),JSON.stringify({ apps: { "drive-chat": { services: { google_drive: ["list_files","read_file"] } } } })); }
async function trustApp(app = "drive-chat", listingTrust = "first_party", manifestSlug?: string, scope = "personal", hidden = false, provenance?: Record<string, unknown>) {
  const relativePath = app;
  const slug = manifestSlug ?? app.split("/").at(-1)!;
  const appDir = join(home, "apps", relativePath);
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "matrix.json"), JSON.stringify({
    name: slug, slug, version: "1.0.0", runtime: "static", runtimeVersion: "^1.0.0",
    scope, listingTrust, ...(hidden ? { hidden: true } : {}), ...provenance,
  }));
  invalidateAppIndexCache();
}
function request(input: unknown, app="drive-chat") {
  const host=new Hono();
  host.route("/",createAppCapabilityRoutes({ homePath:home, ownerIds:["owner"], resolveOwner:()=>owner, integrations:createBotIntegrationClient(transport), aiAllowed:async()=>false }));
  return host.request("/",{method:"POST",body:JSON.stringify({app,input})});
}
it("denies missing/revoked grants, non-owners and other apps before transport",async()=>{
  expect((await request({kind:"integrations.list"})).status).toBe(403); await grant();
  expect((await request({kind:"integrations.list"},"other")).status).toBe(403);
  owner="other"; expect((await request({kind:"integrations.list"})).status).toBe(403);
  expect(transport).not.toHaveBeenCalled();
});
it("defaults trusted first-party apps to every connected integration action without a policy file", async () => {
  await trustApp();
  expect(await (await request({ kind: "capabilities" })).json()).toEqual({ version: 1, integrations: true, ai: false });
  expect(await (await request({ kind: "integrations.list" })).json()).toEqual({
    services: [{ service: "google_drive", account_label: "Work", status: "active" }],
  });
  const description = await (await request({ kind: "integrations.describe", service: "google_drive" })).json();
  expect(description.actions.map((action: { id: string }) => action.id)).toEqual(["list_files", "read_file", "share_file"]);
  expect((await request({ kind: "integrations.call", service: "google_drive", action: "list_files", params: {} })).status).toBe(200);
  expect((await request({ kind: "integrations.call", service: "google_drive", action: "share_file", params: { fileId: "doc", email: "x@example.test" } })).status).toBe(200);
  expect(calls.at(-1)).toMatchObject({ owner: "owner", path: "/call", body: { service: "google_drive", action: "share_file" } });
});
it("uses an explicit trusted-app policy as a restriction instead of expanding it", async () => {
  await trustApp(); await grant();
  const description = await (await request({ kind: "integrations.describe", service: "google_drive" })).json();
  expect(description.actions.map((action: { id: string }) => action.id)).toEqual(["list_files", "read_file"]);
  expect((await request({ kind: "integrations.call", service: "google_drive", action: "share_file", params: { fileId: "doc", email: "x@example.test" } })).status).toBe(403);
});
it("lets an explicit empty policy revoke the trusted default", async () => {
  await trustApp();
  await writeFile(join(home, "system/app-capabilities.json"), JSON.stringify({ apps: { "drive-chat": { services: {} } } }));
  expect(await (await request({ kind: "capabilities" })).json()).toEqual({ version: 1, integrations: false, ai: false });
  expect((await request({ kind: "integrations.call", service: "google_drive", action: "list_files" })).status).toBe(403);
  expect(transport).not.toHaveBeenCalled();
});
it("does not default community apps to owner integrations", async () => {
  await trustApp("drive-chat", "community");
  expect((await request({ kind: "integrations.list" })).status).toBe(403);
  expect(transport).not.toHaveBeenCalled();
});
it.each([
  ["installed", { installed_from: { slug: "drive-chat", installedAt: "2026-10-27T00:00:00.000Z" } }],
  ["forked", { forked_from: { author: "@friend", slug: "drive-chat", version: "1.0.0" } }],
])("does not trust a first-party claim on a host-marked %s app", async (_case, provenance) => {
  await trustApp("drive-chat", "first_party", undefined, "personal", false, provenance);
  expect((await request({ kind: "integrations.list" })).status).toBe(403);
  expect(transport).not.toHaveBeenCalled();
});
it.each([
  ["shared first-party", "shared", false],
  ["hidden personal first-party", "personal", true],
])("does not default %s apps to personal owner integrations", async (_case, scope, hidden) => {
  await trustApp("drive-chat", "first_party", undefined, scope, hidden);
  expect((await request({ kind: "integrations.list" })).status).toBe(403);
  expect(transport).not.toHaveBeenCalled();
});
it("uses the stable manifest slug when the trusted app folder has a different name", async () => {
  await trustApp("generated-folder", "first_party", "drive-chat");
  expect((await request({ kind: "integrations.list" }, "drive-chat")).status).toBe(200);
});
it("applies a folder-keyed owner restriction when Electron identifies the app by slug", async () => {
  await trustApp("generated-folder", "first_party", "drive-chat");
  await writeFile(join(home, "system/app-capabilities.json"), JSON.stringify({
    apps: { "generated-folder": { services: {} } },
  }));
  expect(await (await request({ kind: "capabilities" }, "drive-chat")).json()).toEqual({ version: 1, integrations: false, ai: false });
  expect((await request({ kind: "integrations.call", service: "google_drive", action: "list_files" }, "drive-chat")).status).toBe(403);
  expect(transport).not.toHaveBeenCalled();
});
it("applies a slug-keyed owner restriction when Web identifies the app by folder", async () => {
  await trustApp("generated-folder", "first_party", "drive-chat");
  await writeFile(join(home, "system/app-capabilities.json"), JSON.stringify({
    apps: { "drive-chat": { services: {} } },
  }));
  expect(await (await request({ kind: "capabilities" }, "generated-folder")).json()).toEqual({ version: 1, integrations: false, ai: false });
  expect((await request({ kind: "integrations.call", service: "google_drive", action: "list_files" }, "generated-folder")).status).toBe(403);
  expect(transport).not.toHaveBeenCalled();
});
it("intersects differing owner restrictions across folder and slug aliases", async () => {
  await trustApp("generated-folder", "first_party", "drive-chat");
  await writeFile(join(home, "system/app-capabilities.json"), JSON.stringify({
    apps: {
      "generated-folder": { services: { google_drive: ["list_files", "read_file"] } },
      "drive-chat": { services: { google_drive: ["read_file", "share_file"] } },
    },
  }));
  const description = await (await request({ kind: "integrations.describe", service: "google_drive" }, "drive-chat")).json();
  expect(description.actions.map((action: { id: string }) => action.id)).toEqual(["read_file"]);
  expect((await request({ kind: "integrations.call", service: "google_drive", action: "share_file", params: { fileId: "doc", email: "x@example.test" } }, "generated-folder")).status).toBe(403);
});
it("fails closed when multiple installed manifests claim the same trusted identity", async () => {
  await trustApp("first-folder", "first_party", "drive-chat");
  await trustApp("second-folder", "first_party", "drive-chat");
  expect((await request({ kind: "integrations.list" }, "drive-chat")).status).toBe(403);
  expect(transport).not.toHaveBeenCalled();
});
it("executes granted reads in production through the real owner-scoped client",async()=>{
  await grant();
  const response=await request({kind:"integrations.call",service:"google_drive",action:"list_files",params:{maxResults:25}});
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({data:{files:[{id:"doc1"}]}});
  expect(calls.at(-1)).toMatchObject({owner:"owner",path:"/read-call",body:{service:"google_drive",action:"list_files",label:"Work",connectionId:"conn_work"}});
});
it("only exposes granted runtime actions and connected accounts",async()=>{
  await grant(); const response=await request({kind:"integrations.describe",service:"google_drive"});
  expect((await response.json()).actions.map((a:any)=>a.id)).toEqual(["list_files","read_file"]);
  expect(await (await request({kind:"integrations.list"})).json()).toEqual({services:[{service:"google_drive",account_label:"Work",status:"active"}]});
});
it("rejects writes not granted and malformed/unknown parameters",async()=>{
  await grant(); expect((await request({kind:"integrations.call",service:"google_drive",action:"share_file",params:{fileId:"doc",email:"x@example.test"}})).status).toBe(403);
  expect((await request({kind:"integrations.call",service:"google_drive",action:"read_file",params:{}})).status).toBe(400);
  expect((await request({kind:"integrations.call",service:"google_drive",action:"list_files",params:{made_up:true}})).status).toBe(400);
  expect(calls.some(c=>c.path==="/read-call")).toBe(false);
});
it("does not claim availability when no server integration transport exists",async()=>{
  await grant(); const routes=createAppCapabilityRoutes({homePath:home,ownerIds:["owner"],resolveOwner:()=>owner,integrations:null,aiAllowed:async()=>false});
  const response=await routes.request("/",{method:"POST",body:JSON.stringify({app:"drive-chat",input:{kind:"capabilities"}})});
  expect(await response.json()).toEqual({version:1,integrations:false,ai:false});
});
it("requires explicit selection for multiple accounts and retains immutable identity", async () => {
  await grant();
  transport.mockImplementationOnce(async () => Response.json([{ id:"google_drive",actions:{list_files:{description:"List",risk:"read",params:{}}}}]));
  transport.mockImplementationOnce(async () => Response.json([
    {id:"a",service:"google_drive",account_label:"Work",status:"active"},
    {id:"b",service:"google_drive",account_label:"Personal",status:"active"},
  ]));
  expect((await request({kind:"integrations.call",service:"google_drive",action:"list_files"})).status).toBe(409);
  expect(calls.some(c=>c.path==="/read-call")).toBe(false);
});
it("rechecks grant after account discovery before executing", async () => {
  await grant();
  transport.mockImplementationOnce(async () => Response.json([{ id:"google_drive",actions:{list_files:{description:"List",risk:"read",params:{}}}}]));
  transport.mockImplementationOnce(async () => {
    await writeFile(join(home,"system/app-capabilities.json"),JSON.stringify({apps:{}}));
    return Response.json([{id:"a",service:"google_drive",account_label:"Work",status:"active"}]);
  });
  expect((await request({kind:"integrations.call",service:"google_drive",action:"list_files"})).status).toBe(403);
  expect(calls.some(c=>c.path==="/read-call")).toBe(false);
});
it("rechecks trusted-app status after account discovery before executing a default action", async () => {
  await trustApp();
  transport.mockImplementationOnce(async () => Response.json([{ id:"google_drive",actions:{list_files:{description:"List",risk:"read",params:{}}}}]));
  transport.mockImplementationOnce(async () => {
    // Do not invalidate the discovery cache: execution authorization must
    // still re-read the current manifest trust from disk.
    await writeFile(join(home, "apps/drive-chat/matrix.json"), JSON.stringify({
      name: "drive-chat", slug: "drive-chat", version: "1.0.0", runtime: "static",
      runtimeVersion: "^1.0.0", scope: "personal", listingTrust: "community",
    }));
    return Response.json([{id:"a",service:"google_drive",account_label:"Work",status:"active"}]);
  });
  expect((await request({kind:"integrations.call",service:"google_drive",action:"list_files"})).status).toBe(403);
  expect(calls.some(c=>c.path==="/read-call")).toBe(false);
});
it("allows explicitly granted writes only through the mutation transport", async () => {
  await writeFile(join(home,"system/app-capabilities.json"),JSON.stringify({apps:{"drive-chat":{services:{google_drive:["share_file"]}}}}));
  expect((await request({kind:"integrations.call",service:"google_drive",action:"share_file",label:"Work",params:{fileId:"doc",email:"x@example.test"}})).status).toBe(200);
  expect(calls.at(-1)).toMatchObject({owner:"owner",path:"/call",body:{connectionId:"conn_work",label:"Work",action:"share_file"}});
});

it("admits capabilities and denied grants before policy I/O and releases slots", async () => {
  let release!: (value: boolean) => void;
  const gate = new Promise<boolean>(done => { release = done; });
  const aiAllowed = vi.fn(() => gate);
  const routes = createAppCapabilityRoutes({homePath:home,ownerIds:["owner"],resolveOwner:()=>owner,integrations:null,aiAllowed});
  const call = (kind = "capabilities") => routes.request("/", {method:"POST",body:JSON.stringify({app:"drive-chat",input:{kind}})});
  const work = Array.from({length:8}, () => call());
  await vi.waitFor(() => expect(aiAllowed).toHaveBeenCalledTimes(8));
  expect((await call()).status).toBe(429);
  release(false);
  await Promise.all(work);
  expect((await call()).status).toBe(200);
});

it("counts denied-grant requests toward the120 request budget", async () => {
  const routes=createAppCapabilityRoutes({homePath:home,ownerIds:["owner"],resolveOwner:()=>owner,integrations:null,aiAllowed:async()=>false});
  const call=()=>routes.request("/",{method:"POST",body:JSON.stringify({app:"drive-chat",input:{kind:"integrations.list"}})});
  for(let index=0;index<120;index++) expect((await call()).status).toBe(403);
  expect((await call()).status).toBe(429);
});

it("preserves catalog constraints and rejects invalid Drive IDs before transport calls", async () => {
  await grant();
  const catalog=()=>Response.json([{id:"google_drive",actions:{read_file:{description:"Read",risk:"read",params:{fileId:{type:"string",required:true,minLength:1,maxLength:256,pattern:"^[A-Za-z0-9_-]+$",patternMessage:"Invalid ID"},mimeType:{type:"string",maxLength:128}}}}}]);
  transport.mockImplementationOnce(async()=>catalog());
  const description=await (await request({kind:"integrations.describe",service:"google_drive"})).json();
  expect(description.actions[0].params.fileId).toMatchObject({minLength:1,maxLength:256,pattern:"^[A-Za-z0-9_-]+$"});
  transport.mockImplementationOnce(async()=>catalog());
  expect((await request({kind:"integrations.call",service:"google_drive",action:"read_file",params:{fileId:"bad/id"}})).status).toBe(400);
  expect(calls.some(call=>call.path==="/read-call")).toBe(false);
});

it("reads actual512KiB Drive content through the bounded integration client", async () => {
  await grant();
  transport.mockImplementationOnce(async()=>Response.json([{id:"google_drive",actions:{read_file:{description:"Read",risk:"read",params:{fileId:{type:"string",required:true}}}}}]));
  transport.mockImplementationOnce(async()=>Response.json([{id:"work",service:"google_drive",account_label:"Work",status:"active"}]));
  const content="x".repeat(512*1024);
  transport.mockImplementationOnce(async()=>Response.json({data:{content,mimeType:"text/plain"}}));
  const response=await request({kind:"integrations.call",service:"google_drive",action:"read_file",params:{fileId:"doc"}});
  expect(response.status).toBe(200);
  expect((await response.json()).data.content).toBe(content);
});

it("preserves Gmail history recovery without claiming a current app snapshot", async () => {
  await writeFile(join(home,"system/app-capabilities.json"),JSON.stringify({apps:{"drive-chat":{services:{gmail:["list_history"]}}}}));
  transport.mockImplementationOnce(async()=>Response.json([{id:"gmail",actions:{list_history:{description:"History",risk:"read",params:{startHistoryId:{type:"string",required:true}}}}}]));
  transport.mockImplementationOnce(async()=>Response.json([{id:"mail",service:"gmail",account_label:"Work",status:"active"}]));
  transport.mockImplementationOnce(async()=>Response.json({code:"gmail_history_expired",resync_required:true},{status:409}));
  const response=await request({kind:"integrations.call",service:"gmail",action:"list_history",params:{startHistoryId:"9007199254740993"}});
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({code:"gmail_history_expired",resync_required:true});
});
