import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import { chatGptPlanPeerProof } from "@matrix-os/contracts";
import { createChatGptPlanPeers } from "../../../packages/gateway/src/bots/chatgpt-plan-peers.js";
import { createBotStateDatabase } from "./bot-state-support.js";

it("offers schedule proposals after capability negotiation without granting arbitrary background inference", async () => {
  const database = await createBotStateDatabase(), keys = generateKeyPairSync("ed25519"), der = keys.publicKey.export({ type: "spki", format: "der" });
  const authorizeRoutine = vi.fn(async () => { throw new Error("No approved occurrence"); });
  const peers = createChatGptPlanPeers({ db: database.db, ownerId: "owner", computerId: "computer", authorizeRoutine });
  const snapshot = { deviceId: createHash("sha256").update(der).digest("hex"), accountId: "account", grantRevision: 3,
    enabled: true, background: false, models: [{ id: "gpt-model", displayName: "Model", input: ["text" as const], contextWindow: 128000, maxOutputTokens: 8192 }] };
  try {
    const challenge = peers.challenge("owner");
    const session = await peers.connect("owner", { version: 1, challenge: challenge.challenge, snapshot, publicKey: der.toString("base64url"),
      signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot })), keys.privateKey).toString("base64url") });
    const selection = { instanceId: "matrix_chatgpt_plan", model: "gpt-model", options: [{ id: "accountId", value: "account" }, { id: "grantRevision", value: "3" }] };
    expect(peers.capabilities("owner", session)).not.toHaveProperty("approvedRoutines");
    await expect(peers.resolve(selection, "owner", "routine")).rejects.toThrow();
    expect(peers.capabilities("owner", session, false, false, true)).toMatchObject({ approvedRoutines: true });
    const route = await peers.resolve(selection, "owner", "routine");
    expect((await peers.observe("owner")).authorization).toMatchObject({ enabled: true, background: false, revision: 3 });
    await expect(peers.resolve(selection, "owner", "background")).rejects.toThrow();
    const binding = { ownerId: "owner", botId: "bot_fixture", chatId: "chat_fixture", taskId: "task_fixture", runId: "run_fixture",
      requestClass: "background", ...route, approvedRoutine: { approved: true } } as never;
    expect(await peers.revalidate(binding, new AbortController().signal)).toBe(false);
    await expect(peers.infer(binding, "{}", new AbortController().signal)).rejects.toThrow("unavailable");
    expect(authorizeRoutine).toHaveBeenCalled();
  } finally { peers.close(); await database.destroy(); }
});
