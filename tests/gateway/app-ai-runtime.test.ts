import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeAppAiRoutes } from "../../packages/gateway/src/app-ai/runtime.js";
const mocks = vi.hoisted(() => ({
  principal: vi.fn(() => ({ userId: "owner" })),
  sources: vi.fn(async () => ({ selectedAccessSourceId: "owner_anthropic_key" })),
  launch: vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: "test-only" } })),
  generate: vi.fn(async () => ({ text: "summary" })),
}));
vi.mock("../../packages/gateway/src/request-principal.js", () => ({ requireRequestPrincipal: mocks.principal }));
vi.mock("../../packages/gateway/src/kernel-credentials.js", () => ({ resolveKernelCredentialSources: mocks.sources, buildKernelCredentialLaunch: mocks.launch }));
vi.mock("@matrix-os/kernel", () => ({ generateAppText: mocks.generate, DEFAULT_KERNEL_MODEL: "claude-opus-5", DEFAULT_KERNEL_EFFORT: "high" }));
let homePath: string;
beforeEach(async () => {
  homePath = await mkdtemp(join(tmpdir(), "app-ai-test-"));
  await mkdir(join(homePath, "system"));
  vi.clearAllMocks();
  mocks.principal.mockReturnValue({ userId: "owner" });
  mocks.sources.mockResolvedValue({ selectedAccessSourceId: "owner_anthropic_key" });
});
afterEach(async () => { await rm(homePath, { recursive: true, force: true }); await rm(homePath+"-private",{recursive:true,force:true}); });
async function allow() {
  await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: ["brain"], model: "claude-sonnet-5" }));
}
function request(app = "brain") {
  return createRuntimeAppAiRoutes({ homePath, ownerIds: ["owner"] }).request("/", { method: "POST", body: JSON.stringify({ app, prompt: "notes" }) });
}
it("fails closed without an owner grant", async () => {
  expect((await request()).status).toBe(403);
  expect(mocks.launch).not.toHaveBeenCalled();
});
it("denies a different app and non-owner principal", async () => {
  await allow();
  expect((await request("other")).status).toBe(403);
  mocks.principal.mockReturnValue({ userId: "collaborator" });
  expect((await request()).status).toBe(403);
  expect(mocks.launch).not.toHaveBeenCalled();
});
it("rejects nonowners before policy reads and preserves the owner's full app quota", async () => {
  await writeFile(join(homePath, "system/app-ai.json"), "invalid policy must not be read");
  mocks.principal.mockReturnValue({ userId: "collaborator" });
  const api = createRuntimeAppAiRoutes({ homePath, ownerIds: ["owner"] });
  const post = () => api.request("/", { method: "POST", body: JSON.stringify({ app: "brain", prompt: "notes" }) });
  for (let count = 0; count < 110; count++) expect((await post()).status).toBe(count < 100 ? 403 : 429);
  expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.launch).not.toHaveBeenCalled();
  mocks.principal.mockReturnValue({ userId: "owner" }); await allow();
  for (let count = 0; count < 10; count++) expect((await post()).status).toBe(200);
  expect(mocks.generate).toHaveBeenCalledTimes(10);
});
it("resolves owner credentials server-side and only returns text", async () => {
  await allow();
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "summary" });
  expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-5", prompt: "notes", env: { ANTHROPIC_API_KEY: "test-only" }, signal: expect.any(AbortSignal) }));
});
it("does not convert malformed policy into a grant", async () => {
  await writeFile(join(homePath, "system/app-ai.json"), "not json");
  expect((await request()).status).toBe(503);
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("enforces the included model allowlist before leasing credentials", async () => {
  await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: ["brain"], model: "claude-opus-5" }));
  mocks.sources.mockResolvedValue({ selectedAccessSourceId: "matrix_included" });
  expect((await request()).status).toBe(503);
  expect(mocks.launch).not.toHaveBeenCalled();
});

it("blocks retired Matrix SDK app generation without invoking the generator", async () => {
  await allow();
  mocks.sources.mockResolvedValue({ selectedAccessSourceId: "matrix_included" });
  mocks.launch.mockRejectedValueOnce(new Error("Selected AI access is unavailable"));
  expect((await request()).status).toBe(503);
  expect(mocks.generate).not.toHaveBeenCalled();
});

it("discovers owner-authorized connected AI routes", async () => {
  await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: ["brain"] }));
  const canonical = {
    accessSources: [{id:"matrix_cloudflare",state:"ready",checkedAt:new Date().toISOString(),staleAfter:new Date(Date.now()+60000).toISOString(),eligibleModelIds:["@cf/zai-org/glm-5.3-flash"]}],
    models: [{id:"@cf/zai-org/glm-5.3-flash",status:"current",eligibleAccessSourceIds:["matrix_cloudflare"]}],
  };
  const api=createRuntimeAppAiRoutes({homePath,ownerIds:["owner"],providerSnapshotReader:{getSnapshot:async()=>canonical as never},fundedCredentialProvider:{enabled:true} as never});
  const response=await api.request("/routes?app=brain");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({routes:[{harnessId:"matrix_ai",accessSourceId:"matrix_cloudflare",availability:"available"}]});
  expect((await api.request("/routes?app=other")).status).toBe(403);
});
it("selects only the exact connected route and fails closed after policy revocation",async()=>{
  await writeFile(join(homePath,"system/app-ai.json"),JSON.stringify({apps:["brain"]}));
  const canonical={accessSources:[{id:"matrix_cloudflare",state:"ready",checkedAt:new Date().toISOString(),staleAfter:new Date(Date.now()+60000).toISOString(),eligibleModelIds:["@cf/zai-org/glm-5.3-flash"]}],models:[{id:"@cf/zai-org/glm-5.3-flash",status:"current",eligibleAccessSourceIds:["matrix_cloudflare"]}]};
  const fetchImpl=vi.fn(async()=>Response.json({choices:[{finish_reason:"stop",message:{content:"result"}}]}));
  const provider={enabled:true,getCredential:async()=>{
    await writeFile(join(homePath,"system/app-ai.json"),JSON.stringify({apps:[]}));
    return {token:"funded-only",relayBaseUrl:"https://relay.matrix.test"};
  }};
  const api=createRuntimeAppAiRoutes({homePath,ownerIds:["owner"],providerSnapshotReader:{getSnapshot:async()=>canonical as never},fundedCredentialProvider:provider as never,fetchImpl});
  const route={harnessId:"matrix_ai",accountId:null,accessSourceId:"matrix_cloudflare",modelId:"@cf/zai-org/glm-5.3-flash"};
  expect((await api.request("/",{method:"POST",body:JSON.stringify({app:"brain",prompt:"notes",route})})).status).toBe(503);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("legacy fixed-model grants reject explicit connected selection before dispatch",async()=>{
  await allow();
  const fetchImpl=vi.fn();
  const api=createRuntimeAppAiRoutes({homePath,ownerIds:["owner"],fetchImpl});
  const route={harnessId:"matrix_ai",accountId:null,accessSourceId:"matrix_cloudflare",modelId:"@cf/zai-org/glm-5.3-flash"};
  expect((await api.request("/",{method:"POST",body:JSON.stringify({app:"brain",prompt:"notes",route})})).status).toBe(403);
  expect(await (await api.request("/routes?app=brain")).json()).toEqual({routes:[],defaultRoute:null});
  expect(fetchImpl).not.toHaveBeenCalled();expect(mocks.launch).not.toHaveBeenCalled();
});

it("fixed owner route rejects an explicit alternate even when both are ready",async()=>{
  const route={harnessId:"matrix_ai",accountId:null,accessSourceId:"matrix_cloudflare",modelId:"@cf/zai-org/glm-5.3-flash"};
  await writeFile(join(homePath,"system/app-ai.json"),JSON.stringify({apps:["brain"],route}));
  const api=createRuntimeAppAiRoutes({homePath,ownerIds:["owner"]});
  expect((await api.request("/",{method:"POST",body:JSON.stringify({app:"brain",prompt:"notes",route:{...route,modelId:"@cf/other/model"}})})).status).toBe(403);
});
