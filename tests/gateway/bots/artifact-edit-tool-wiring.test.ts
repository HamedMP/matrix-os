import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BotToolRequestSchema } from "@matrix-os/contracts";
import { createBotTools } from "../../../packages/bot-runtime/src/tools.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import type { ManagedPiRuntimeBinding, BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { ensureBotWorkspace } from "../../../packages/gateway/src/bots/instantiation.js";
import { resolveBotWorkspaceRoot } from "../../../packages/gateway/src/chat/bot-workspace-root.js";

it.each(["Chat", "Bot"])("lets an admitted %s model read an exact digest and edit an existing workspace file", async surface => {
  const home = await mkdtemp(join(tmpdir(), "artifact-tool-wiring-"));
  try {
    let root = join(home, "workspace");
    let binding: ManagedPiRuntimeBinding | BotRuntimeBinding;
    if (surface === "Bot") {
      const botId = "bot_0123456789abcdef01234567";
      await ensureBotWorkspace(home, botId);
      const resolved = await resolveBotWorkspaceRoot({ homePath: home,
        owner: { type: "personal", ownerId: "owner" }, ref: { kind: "bot_workspace", botId } });
      root = resolved.primaryWorkspaceRoot;
      binding = { ownerId: "owner", botId, chatId: "chat", runId: "run", taskId: "task",
        rootFingerprint: resolved.fingerprint, capabilities: ["artifact.read", "artifact.write"], requestClass: "interactive" } as BotRuntimeBinding;
    } else {
      binding = { kind: "managed_chat", ownerId: "owner", chatId: "chat", runId: "run",
        capabilities: ["artifact.read", "artifact.write"], requestClass: "interactive" } as ManagedPiRuntimeBinding;
    }
    await mkdir(join(root, "repo"), { recursive: true });
    const target = join(root, "repo", "tracked.txt");
    await writeFile(target, "original\n");
    const dispatcher = createBotToolDispatcher({ homePath: home, managedWorkspace: async () => root });
    const broker = { tool: async (value: unknown) => {
      const request = BotToolRequestSchema.parse(value);
      return (await dispatcher.dispatch(binding, request, new AbortController().signal)).result;
    } };
    const tools = createBotTools({ capabilities: ["artifact.read", "artifact.write"], broker: broker as never,
      state: { waitingForPerson: false, effectUnknown: false } });
    const reader = tools.find(tool => tool.name === "read_artifact")!;
    const writer = tools.find(tool => tool.name === "write_artifact")!;
    const read = await reader.execute("read", { path: "repo/tracked.txt", withHash: true }, new AbortController().signal);
    const text = read.content.find(item => item.type === "text");
    expect(text?.type === "text" && text.text).toBe(JSON.stringify({ kind: "artifact_text", content: "original\n",
      sha256: createHash("sha256").update("original\n").digest("hex"), size: 9, untrusted: true }));
    const snapshot = JSON.parse(text?.type === "text" ? text.text : "{}");
    await writer.execute("edit", { path: "repo/tracked.txt", content: "edited\n", mimeType: "text/plain",
      expectedSha256: snapshot.sha256 }, new AbortController().signal);
    expect(await readFile(target, "utf8")).toBe("edited\n");
  } finally { await rm(home, { recursive: true, force: true }); }
});
