import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import { ensureBotWorkspace } from "../../../packages/gateway/src/bots/instantiation.js";
import { withBotProviderInstance } from "../../../packages/gateway/src/bots/provider-instance.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
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
    const stale = join(workspace, ".bot-save-00000000-0000-0000-0000-000000000000.tmp");
    await writeFile(stale, "partial");
    await utimes(stale, new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 60 * 60_000));
    await writeFile(join(home, "outside-target"), "keep");
    const linked = join(workspace, ".bot-save-11111111-1111-1111-1111-111111111111.tmp");
    await symlink(join(home, "outside-target"), linked);
    await tools.dispatch(binding, write("notes.md", "v3"), signal);
    await expect(readFile(join(workspace, "notes.md"), "utf8")).resolves.toBe("v3");
    await expect(readFile(stale, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, "outside-target"), "utf8")).resolves.toBe("keep");
    expect((await readdir(workspace)).filter((name) => name.endsWith(".tmp"))).toEqual([".bot-save-11111111-1111-1111-1111-111111111111.tmp"]);
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

  it("exists only in the orchestrator's admission catalog, once", async () => {
    const getCatalog = vi.fn(async () => served);
    const admission = withBotProviderInstance({ getCatalog });
    const catalog = await admission.getCatalog({ userId: OWNER } as never);
    expect(catalog.drivers.map((driver) => driver.kind)).toEqual(["hermes", "matrix_bot"]);
    expect(catalog.instances).toEqual([expect.objectContaining({
      id: "matrix_bot_default", driverKind: "matrix_bot", catalogRevision: "rev_1",
      supports: expect.objectContaining({ permissionModes: ["default"], attachments: [] }),
    })]);
    // The served catalog itself is untouched, so no model picker lists the bot runtime.
    expect(served.instances).toEqual([]);
    const again = withBotProviderInstance({ getCatalog: async () => catalog });
    expect((await again.getCatalog({ userId: OWNER } as never)).instances).toHaveLength(1);
  });
});
