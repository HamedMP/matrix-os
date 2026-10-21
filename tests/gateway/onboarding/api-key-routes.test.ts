import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createSettingsRoutes } from "../../../packages/gateway/src/routes/settings.js";

function stubChannelManager() {
  return {
    status: () => ({}),
    start: async () => {},
    stop: async () => {},
    send: () => {},
    replay: async () => {},
  };
}

describe("Settings: API key endpoints", () => {
  let homePath: string;
  let root: string;
  let app: Hono;

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_AUTH", "");
    root = resolve(mkdtempSync(join(tmpdir(), "settings-apikey-")));
    homePath = join(root, "home");
    mkdirSync(join(homePath, "system"), { recursive: true });
    writeFileSync(join(homePath, "system/config.json"), "{}");
    const routes = createSettingsRoutes({
      homePath,
      channelManager: stubChannelManager() as never,
    });
    app = new Hono();
    app.route("/api/settings", routes);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("GET /api/settings/api-key/status", () => {
    it("returns hasKey: false when no key stored", async () => {
      const res = await app.request("/api/settings/api-key/status");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ hasKey: false });
    });

    it("returns hasKey: true when key stored", async () => {
      writeFileSync(
        join(homePath, "system/config.json"),
        JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-x" } }),
      );
      const res = await app.request("/api/settings/api-key/status");
      const data = await res.json();
      expect(data).toEqual({ hasKey: true });
    });
  });

  describe("POST /api/settings/api-key", () => {
    it("rejects missing apiKey", async () => {
      const res = await app.request("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });

    it("rejects invalid format", async () => {
      const res = await app.request("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "bad-key" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });

    it("validates and stores a valid key", async () => {
      // Mock the live validation fetch
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      const res = await app.request("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-ant-valid123" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.valid).toBe(true);

      // Verify stored
      const credential = JSON.parse(readFileSync(join(homePath, "system/ai-providers/anthropic-key.json"), "utf-8"));
      expect(credential.apiKey).toBe("sk-ant-valid123");
    });

    it("returns error when live validation fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

      const res = await app.request("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-ant-invalid" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });
  });
});

it("legacy key replacement and status use the canonical workflow source after connection and logout", async () => {
  const { createOwnerAnthropicKeySaver, revokeOwnerAnthropicKey, readOwnerAnthropicKey } = await import("../../../packages/gateway/src/ai-providers/owner-anthropic-key.js");
  const { buildKernelEnv } = await import("../../../packages/gateway/src/kernel-credentials.js");
  const root = resolve(mkdtempSync(join(tmpdir(), "legacy-key-canonical-")));
  const home = join(root, "home");
  vi.stubEnv("ANTHROPIC_API_KEY", "operator-key"); vi.stubEnv("CLAUDE_CODE_AUTH", "true");
  const routes = new Hono().route("/api/settings", createSettingsRoutes({ homePath: home, channelManager: stubChannelManager() as never }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  try {
    mkdirSync(join(home, "system"), { recursive: true }); writeFileSync(join(home, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-legacy" }, theme: "dark" }));
    await createOwnerAnthropicKeySaver({ homePath: home })("sk-ant-workflow");
    const update = async (key: string) => routes.request("/api/settings/api-key", { method: "POST", body: JSON.stringify({ apiKey: key }), headers: { "Content-Type": "application/json" } });
    expect((await update("sk-ant-new" )).status).toBe(200);
    expect(await readOwnerAnthropicKey(home)).toMatchObject({ key: "sk-ant-new" });
    expect((await buildKernelEnv(home, {}, "owner_anthropic_key")).ANTHROPIC_API_KEY).toBe("sk-ant-new");
    await revokeOwnerAnthropicKey(home);
    expect(await (await routes.request("/api/settings/api-key/status")).json()).toEqual({ hasKey: false });
    expect((await update("sk-ant-reconnect")).status).toBe(200);
    expect((await buildKernelEnv(home, {}, "owner_anthropic_key")).ANTHROPIC_API_KEY).toBe("sk-ant-reconnect");
    expect(JSON.parse(readFileSync(join(home, "system/config.json"), "utf8"))).toEqual({ kernel: { anthropicApiKey: "sk-ant-legacy" }, theme: "dark" });
  } finally { rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

it("legacy key writes share durable workflow admission and leave the current key intact while busy", async()=>{
 const {mkdir,mkdtemp,rm}=await import("node:fs/promises");
 const {createNativeProviderWriterLease}=await import("../../../packages/gateway/src/ai-providers/native-provider-writer-lease.js");
 const {createOwnerAnthropicKeySaver,readOwnerAnthropicKey}=await import("../../../packages/gateway/src/ai-providers/owner-anthropic-key.js");
 const root=await mkdtemp(join(tmpdir(),"legacy-key-lease-")),home=join(root,"home");await mkdir(home);
 const routes=new Hono().route("/api/settings",createSettingsRoutes({homePath:home,channelManager:stubChannelManager() as never}));
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true}));
 let release:(()=>Promise<void>)|undefined;
 try{
  await createOwnerAnthropicKeySaver({homePath:home})("sk-ant-current");
  release=await createNativeProviderWriterLease(home).acquire("claude");
  const write=()=>routes.request("/api/settings/api-key",{method:"POST",body:JSON.stringify({apiKey:"sk-ant-replacement"}),headers:{"Content-Type":"application/json"}});
  expect((await write()).status).toBe(503);
  expect(await readOwnerAnthropicKey(home)).toMatchObject({key:"sk-ant-current"});
  await release();release=undefined;
  expect((await write()).status).toBe(200);
  expect(await readOwnerAnthropicKey(home)).toMatchObject({key:"sk-ant-replacement"});
 }finally{await release?.();await rm(root,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllGlobals();}
});

it.each([42,"sk-ant-"+"x".repeat(4096)])("rejects malformed or oversized legacy keys before validation",async apiKey=>{
 const home=resolve(mkdtempSync(join(tmpdir(),"legacy-key-invalid-")));
 const routes=new Hono().route("/api/settings",createSettingsRoutes({homePath:home,channelManager:stubChannelManager() as never}));
 const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
 try{expect((await routes.request("/api/settings/api-key",{method:"POST",body:JSON.stringify({apiKey})})).status).toBe(400);expect(fetch).not.toHaveBeenCalled();}
 finally{rmSync(home,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllGlobals();}
});
