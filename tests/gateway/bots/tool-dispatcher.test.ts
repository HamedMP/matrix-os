import { createHash } from "node:crypto";
import { BotToolRequestSchema } from "@matrix-os/contracts";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import { ensureBotWorkspace } from "../../../packages/gateway/src/bots/instantiation.js";
import { withBotProviderInstance } from "../../../packages/gateway/src/bots/provider-instance.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotToolDispatcher, sweepBotWorkspaceSaves } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import { resolveBotWorkspaceRoot } from "../../../packages/gateway/src/chat/bot-workspace-root.js";

const BOT_ID = "bot_0123456789abcdef01234567";
const OWNER = "user_owner_1";
let home: string;
let binding: BotRuntimeBinding;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "matrix-bot-tools-"));
  await ensureBotWorkspace(home, BOT_ID);
  const root = await resolveBotWorkspaceRoot({ homePath: home, owner: { type: "personal", ownerId: OWNER }, ref: { kind: "bot_workspace", botId: BOT_ID } });
  binding = {
    runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", ownerId: OWNER, botId: BOT_ID, chatId: "chat_tools1",
    taskId: "task_tools1234", runId: "run_tools1", rootFingerprint: root.fingerprint,
    route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 },
    accessSourceId: "matrix_included", capabilities: ["artifact.read", "artifact.write"], requestClass: "interactive",
  };
});
afterEach(async () => rm(home, { recursive: true, force: true }));

const write = (relPath: string, content = "# Acme", extra: Record<string, unknown> = {}) =>
  ({ toolCallId: "call_w", capability: "artifact.write", args: { relPath, content, mimeType: "text/markdown", ...extra } }) as never;
const read = (relPath: string) => ({ toolCallId: "call_r", capability: "artifact.read", args: { relPath } }) as never;

describe("bot tool dispatcher", () => {
  it("reports a routine model mismatch before the broker can dispatch an effect checkpoint", async () => {
    const propose = vi.fn();
    const tools = createBotToolDispatcher({ homePath: home, routines: { propose, list: vi.fn(), control: vi.fn() } as never });
    const personal = { ...binding, accessSourceId: "matrix_chatgpt_plan", subscription: { accountId: "fixture", computerId: "fixture", grantRevision: 1, peerId: "00000000-0000-4000-8000-000000000001" } };
    const request = BotToolRequestSchema.parse({ toolCallId: "routine_bad_model", capability: "routine.propose", args: {
      name: "Fixture", prompt: "Reply OK", schedule: { kind: "interval", everyMs: 60000 },
      selection: { instanceId: "matrix_chatgpt_plan", model: "Bot display name" }, authorizedEffects: ["read"] } });
    await expect(tools.prepare!(personal, request, signal)).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(propose).not.toHaveBeenCalled();
  });
  it("saves and reads text files inside the bot's own workspace", async () => {
    const tools = createBotToolDispatcher({ homePath: home });
    const saved = await tools.dispatch(binding, write("briefs/acme brief.md", "# Acme\nGrowing."), signal);
    expect(saved.result).toEqual({ ok: true, content: [{ type: "text", text: "Saved briefs/acme brief.md (15 bytes)." }] });
    expect(saved.outcomeRef).toMatch(/^artifact:[a-f0-9]{32}$/);
    await expect(readFile(join(home, "bots", BOT_ID, "briefs", "acme brief.md"), "utf8")).resolves.toBe("# Acme\nGrowing.");
    await expect(tools.dispatch(binding, read("briefs/acme brief.md"), signal))
      .resolves.toEqual({ result: { ok: true, content: [{ type: "text", text: "# Acme\nGrowing." }] } });
    expect(tools.effectClass(write("a.md"))).toBe("write");
    expect(tools.effectClass(read("a.md"))).toBe("read");
  });

  it("refuses a replaced workspace, links, missing files, and revision-checked replacement", async () => {
    const tools = createBotToolDispatcher({ homePath: home });
    await expect(tools.dispatch({ ...binding, rootFingerprint: "0".repeat(64) }, write("a.md"), signal))
      .rejects.toEqual(new BotBrokerActionError("stale_generation"));
    await mkdir(join(home, "outside"));
    await symlink(join(home, "outside"), join(home, "bots", BOT_ID, "linked"));
    await expect(tools.dispatch(binding, write("linked/a.md"), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    await writeFile(join(home, "outside", "secret.md"), "secret");
    await symlink(join(home, "outside", "secret.md"), join(home, "bots", BOT_ID, "secret.md"));
    await expect(tools.dispatch(binding, write("secret.md"), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    await expect(tools.dispatch(binding, read("secret.md"), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    await expect(readFile(join(home, "outside", "secret.md"), "utf8")).resolves.toBe("secret");
    await expect(tools.dispatch(binding, read("missing.md"), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    await expect(tools.dispatch(binding, write("a.md", "x", { replace: { baseRevision: 1 } }), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
  });

  it("rejects changed, oversized, linked, and out-of-range binary chunks without lifting the text limit", async () => {
    const tools = createBotToolDispatcher({ homePath: home });
    const path = join(home, "bots", BOT_ID, "attachment.bin");
    const bytes = Buffer.alloc(256 * 1024, 0x91);
    await writeFile(path, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const chunkRead = (offset = 0, hash = sha256) => BotToolRequestSchema.parse({ toolCallId: "call_chunk", capability: "artifact.read",
      args: { relPath: "attachment.bin", chunk: { offset, length: 32768, sha256: hash } } });
    await expect(tools.dispatch(binding, read("attachment.bin"), signal)).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(tools.dispatch(binding, chunkRead(bytes.length + 1), signal)).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(tools.dispatch(binding, chunkRead(0, "0".repeat(64)), signal)).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
    await writeFile(path, Buffer.alloc(bytes.length, 0x92));
    await expect(tools.dispatch(binding, chunkRead(), signal)).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
    await expect(tools.dispatch(binding, chunkRead(), signal)).rejects.toMatchObject({ code: "invalid_arguments" });
    await rm(path);
    await writeFile(join(home, "secret.bin"), bytes);
    await symlink(join(home, "secret.bin"), path);
    await expect(tools.dispatch(binding, chunkRead(), signal)).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("keeps the previous file when a save fails, and clears stale save files without following links", async () => {
    const tools = createBotToolDispatcher({ homePath: home });
    await tools.dispatch(binding, write("notes.md", "v1"), signal);
    const workspace = join(home, "bots", BOT_ID);
    await chmod(workspace, 0o555);
    try {
      await expect(tools.dispatch(binding, write("notes.md", "v2"), signal)).rejects.toThrow();
    } finally {
      await chmod(workspace, 0o755);
    }
    await expect(readFile(join(workspace, "notes.md"), "utf8")).resolves.toBe("v1");
    const staging = join(workspace, ".bot-save");
    const stale = join(staging, "00000000-0000-0000-0000-000000000000.tmp");
    await writeFile(stale, "partial");
    await utimes(stale, new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 60 * 60_000));
    await writeFile(join(home, "outside-target"), "keep");
    const linked = join(staging, "11111111-1111-1111-1111-111111111111.tmp");
    await symlink(join(home, "outside-target"), linked);
    const fresh = join(staging, "22222222-2222-2222-2222-222222222222.tmp");
    await writeFile(fresh, "in progress");
    // The recurring sweep removes only old staged files, never following a link.
    await sweepBotWorkspaceSaves(home);
    await expect(readFile(stale, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, "outside-target"), "utf8")).resolves.toBe("keep");
    expect((await readdir(staging)).sort()).toEqual(["11111111-1111-1111-1111-111111111111.tmp", "22222222-2222-2222-2222-222222222222.tmp"]);
    await tools.dispatch(binding, write("notes.md", "v3"), signal);
    await expect(readFile(join(workspace, "notes.md"), "utf8")).resolves.toBe("v3");
    // The staging directory is reserved.
    await expect(tools.dispatch(binding, write(".bot-save/x.md"), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
  });

  it("eventually sweeps staging files beyond both per-pass scan limits", async () => {
    const staleAt = new Date(Date.now() - 60 * 60_000);
    const staging = join(home, "bots", BOT_ID, ".bot-save");
    await mkdir(staging);
    for (let index = 0; index < 257; index += 1) {
      const path = join(staging, `00000000-0000-0000-0000-${String(index).padStart(12, "0")}.tmp`);
      await writeFile(path, "partial");
      await utimes(path, staleAt, staleAt);
    }
    for (let index = 0; index < 128; index += 1) {
      const workspace = join(home, "bots", `bot_${String(index).padStart(24, "0")}`);
      await mkdir(join(workspace, ".bot-save"), { recursive: true });
      const path = join(workspace, ".bot-save", "00000000-0000-0000-0000-000000000000.tmp");
      await writeFile(path, "partial");
      await utimes(path, staleAt, staleAt);
    }
    // Two workspace rounds are needed for two staging visits; filesystem
    // iteration may place this workspace last (129 workspaces, 257 files).
    for (let pass = 0; pass < 4; pass += 1) await sweepBotWorkspaceSaves(home);
    expect(await readdir(staging)).toEqual([]);
    for (let index = 0; index < 128; index += 1) {
      const workspace = join(home, "bots", `bot_${String(index).padStart(24, "0")}`);
      expect(await readdir(join(workspace, ".bot-save"))).toEqual([]);
    }
  });

  it("refuses capabilities that have no tool yet", async () => {
    const tools = createBotToolDispatcher({ homePath: home });
    await expect(tools.dispatch(binding, { toolCallId: "call_m", capability: "memory.search", args: { query: "x", limit: 3 } } as never, signal))
      .rejects.toEqual(new BotBrokerActionError("not_granted"));
  });
});

describe("bot provider instance", () => {
  const served: CanonicalProviderCatalog = {
    revision: "rev_1",
    drivers: [{ kind: "hermes", displayName: "Hermes", adapterVersion: "1.0.0", capabilityClass: "system_agent" }],
    instances: [],
  };

  it("preserves scoped discovery for ordinary and concrete managed Bot selections", async () => {
    const getCatalog = vi.fn(async () => served);
    const admission = withBotProviderInstance({ getCatalog });
    const principal = { userId: OWNER } as never;
    const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
    await admission.getCatalog(principal, selection);
    expect(getCatalog).toHaveBeenCalledWith(principal, selection);
    getCatalog.mockClear();
    await admission.getCatalog(principal, { ...selection, instanceId: "matrix_bot_default" });
    expect(getCatalog).toHaveBeenCalledWith(principal, selection);
  });

  it("exists only in the orchestrator's admission catalog, once", async () => {
    const getCatalog = vi.fn(async () => served);
    const admission = withBotProviderInstance({ getCatalog });
    const catalog = await admission.getCatalog({ userId: OWNER } as never);
    expect(catalog.drivers.map((driver) => driver.kind)).toEqual(["hermes", "matrix_bot"]);
    expect(catalog.instances).toEqual([expect.objectContaining({
      id: "matrix_bot_default", driverKind: "matrix_bot", catalogRevision: "rev_1",
      supports: expect.objectContaining({ permissionModes: ["default"], attachments: ["file", "image"] }),
    })]);
    // The served catalog itself is untouched, so no model picker lists the bot runtime.
    expect(served.instances).toEqual([]);
    const again = withBotProviderInstance({ getCatalog: async () => catalog });
    expect((await again.getCatalog({ userId: OWNER } as never)).instances).toHaveLength(1);
  });
});

it("proposes routines and controls them through server-bound Bot identity",async()=>{
 binding={...binding, accessSourceId:"matrix_chatgpt_plan", route:{...binding.route,modelId:"fixture-model"},
   subscription:{accountId:"fixture",computerId:"fixture",grantRevision:1,peerId:"00000000-0000-4000-8000-000000000001"}};
 const proposal={name:"Fixture",prompt:"Read fixture",schedule:{kind:"interval",everyMs:60000},selection:{instanceId:"matrix_chatgpt_plan",model:"fixture-model"},authorizedEffects:["read"]};
 const routines={propose:vi.fn(async()=>({interactionId:"in_fixture",status:"pending" as const})),list:vi.fn(async()=>[]),control:vi.fn(async()=>{throw new Error("Unexpected fixture control");})};
 const tools=createBotToolDispatcher({homePath:home,routines});
 const request=BotToolRequestSchema.parse({toolCallId:"routine_fixture",capability:"routine.propose",args:proposal});
 expect((await tools.dispatch(binding,request,signal)).result.ok).toBe(true);expect(routines.propose).toHaveBeenCalledWith(binding,proposal);
 const list=BotToolRequestSchema.parse({toolCallId:"routine_status_fixture",capability:"routine.control",args:{operation:"list"}});
 await tools.dispatch(binding,list,signal);expect(routines.list).toHaveBeenCalledWith(binding.ownerId,binding.botId);
 await expect(tools.dispatch({...binding,requestClass:"background"},request,signal)).rejects.toMatchObject({code:"not_granted"});
 expect(BotToolRequestSchema.safeParse({...request,args:{...proposal,ownerId:"foreign"}}).success).toBe(false);
});

it.each(["routine.propose", "routine.control"] as const)("refuses %s on shared bindings before exposing or changing personal routines", async capability => {
  const routines = { propose: vi.fn(async () => ({ interactionId: "in_fixture", status: "pending" as const })),
    list: vi.fn(async () => []), control: vi.fn(async () => { throw new Error("Unexpected control"); }) };
  const dispatcher = createBotToolDispatcher({ homePath: home, routines });
  const group = { ...binding, group: { scopeId: "scope_company", actorId: "user_member", authEpoch: 1,
    authorityGeneration: 1, authorityRuntimeId: "runtime_owner", sessionGeneration: "1" } };
  const args = capability === "routine.propose"
    ? { name: "Fixture", prompt: "Read fixture", schedule: { kind: "interval", everyMs: 60000 },
      selection: { instanceId: "matrix_chatgpt_plan", model: "fixture-model" }, authorizedEffects: ["read"] }
    : { operation: "list" };
  const request = BotToolRequestSchema.parse({ toolCallId: "shared_routine_denied", capability, args });
  await expect(dispatcher.dispatch(group, request, signal)).rejects.toEqual(new BotBrokerActionError("not_granted"));
  expect(routines.propose).not.toHaveBeenCalled();
  expect(routines.list).not.toHaveBeenCalled();
  expect(routines.control).not.toHaveBeenCalled();
});
