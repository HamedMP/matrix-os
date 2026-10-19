import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComputeBudgetError } from "../../packages/workspace-worker/src/data/compute-budget.js";
import { createWorkspaceRoutes } from "../../packages/workspace-worker/src/routes.js";
import type { WorkspaceRepository } from "../../packages/workspace-worker/src/data/repository.js";

const bootstrap = { layout: { windows: [] }, modules: [], apps: [], icons: {}, revision: 0 };
const repository = {
  bootstrap: vi.fn(async () => bootstrap), saveLayout: vi.fn(async () => ({ revision: 1 })),
  listFiles: vi.fn(async () => []), file: vi.fn(async () => null), commitFile: vi.fn(),
  listChats: vi.fn(async () => []), createChat: vi.fn(), chat: vi.fn(async () => null),
} as unknown as WorkspaceRepository;
const files = { read: vi.fn(), write: vi.fn(), remove: vi.fn() };
const runtime = { status: vi.fn(async () => ({ state: "sleeping", placement: "pooled", activeRuns: 0 })), enqueue: vi.fn(async () => ({ queued: true })) };
const auth = { previewBearer: { token: "preview_secret_very_long_value", ownerId: "fixed_preview_owner" } };
const request = (path: string, init: RequestInit = {}) => new Request(`https://preview.test${path}`, { ...init, headers: { authorization: `Bearer ${auth.previewBearer.token}`, ...init.headers } });

beforeEach(() => vi.clearAllMocks());
describe("shared desktop data routes", () => {
  it("denies missing auth and disabled preview before data access", async () => {
    const app = createWorkspaceRoutes({ repository, files, runtime, auth, previewEnabled: true });
    expect((await app.fetch(new Request("https://preview.test/api/shell/bootstrap"))).status).toBe(401);
    const disabled = createWorkspaceRoutes({ repository, files, runtime, auth, previewEnabled: false });
    expect((await disabled.fetch(request("/api/shell/bootstrap"))).status).toBe(404);
    expect(repository.bootstrap).not.toHaveBeenCalled();
  });
  it("serves real bootstrap contract and read APIs without waking compute", async () => {
    const app = createWorkspaceRoutes({ repository, files, runtime, auth, previewEnabled: true });
    for (const path of ["/health", "/api/shell/bootstrap", "/api/layout", "/api/files", "/api/chats", "/api/workspace/runtime"]) {
      expect((await app.fetch(request(path))).status).toBe(200);
    }
    expect(repository.bootstrap).toHaveBeenCalledWith("fixed_preview_owner");
    expect(runtime.enqueue).not.toHaveBeenCalled();
  });
  it("ignores spoofed owner headers and rejects owner payload and traversal", async () => {
    const app = createWorkspaceRoutes({ repository, files, runtime, auth, previewEnabled: true });
    await app.fetch(request("/api/shell/bootstrap", { headers: { "x-owner-id": "victim" } }));
    expect(repository.bootstrap).toHaveBeenCalledWith("fixed_preview_owner");
    expect((await app.fetch(request("/api/files/text?path=../private", { method: "GET" }))).status).toBe(400);
    expect((await app.fetch(request("/api/workspace/actions", { method: "POST", body: JSON.stringify({ type: "wake", ownerId: "victim" }) }))).status).toBe(400);
    expect(runtime.enqueue).not.toHaveBeenCalled();
  });
  it("validates actions and body bounds before admitting work", async () => {
    const app = createWorkspaceRoutes({ repository, files, runtime, auth, previewEnabled: true });
    expect((await app.fetch(request("/api/workspace/actions", { method: "POST", body: JSON.stringify({ type: "wake" }) }))).status).toBe(202);
    expect(runtime.enqueue).toHaveBeenCalledWith("fixed_preview_owner", { type: "wake" });
    expect((await app.fetch(request("/api/layout", { method: "PUT", body: "x".repeat(140_000) }))).status).toBe(413);
    expect(repository.saveLayout).not.toHaveBeenCalled();
  });
  it("returns a safe service error on database failure", async () => {
    vi.mocked(repository.bootstrap).mockRejectedValueOnce(new Error("Postgres postgres://secret@db/private"));
    const app = createWorkspaceRoutes({ repository, files, runtime, auth, previewEnabled: true });
    const result = await app.fetch(request("/api/shell/bootstrap"));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("secret");
  });
});

describe("durable chat admission", () => {
  it("delegates Chat input and budget to one atomic admission boundary", async () => {
    const admitChatMessage=vi.fn();
    const enqueue=vi.fn(async()=>({state:'queued',jobId:'request1',chatId:'chat_server'}));
    const app=createWorkspaceRoutes({repository:{...repository,admitChatMessage},files,runtime:{...runtime,enqueue},auth,previewEnabled:true});
    const action={type:'chat',chatId:'chat_new',idempotencyKey:'request1',message:'Run'};
    const result=await app.fetch(request('/api/workspace/actions',{method:'POST',body:JSON.stringify(action)}));
    expect(result.status).toBe(202); expect(await result.json()).toMatchObject({chatId:'chat_server'});
    expect(enqueue).toHaveBeenCalledWith('fixed_preview_owner',action);
    expect(admitChatMessage).not.toHaveBeenCalled();
  });
});

describe('compute allowance denial',()=>{
  it('returns a safe quota error and leaves saved data readable without retrying compute',async()=>{
    const enqueue=vi.fn(async()=>{throw new ComputeBudgetError('exhausted');});
    const app=createWorkspaceRoutes({repository,files,runtime:{...runtime,enqueue},auth,previewEnabled:true});
    const denied=await app.fetch(request('/api/workspace/actions',{method:'POST',body:JSON.stringify({type:'wake'})}));
    expect(denied.status).toBe(429);expect(await denied.json()).toEqual({error:'Compute allowance unavailable'});
    expect((await app.fetch(request('/api/shell/bootstrap'))).status).toBe(200);expect(enqueue).toHaveBeenCalledOnce();
  });
});

describe('completed action replay',()=>{
 it('returns the stored completed outcome without claiming new queue acceptance',async()=>{
  const enqueue=vi.fn(async()=>({state:'completed',jobId:'existing',chatId:'chat_existing'}));
  const app=createWorkspaceRoutes({repository,files,runtime:{...runtime,enqueue},auth,previewEnabled:true});
  const response=await app.fetch(request('/api/workspace/actions',{method:'POST',body:JSON.stringify({type:'chat',chatId:'chat_existing',idempotencyKey:'existing',message:'already done'})}));
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({state:'completed'});
 });
});
