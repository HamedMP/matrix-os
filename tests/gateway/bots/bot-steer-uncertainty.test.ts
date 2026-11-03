import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { CanonicalChatMessagePart, BotModelRoute } from "@matrix-os/contracts";
import { createBotTaskOrchestrator } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { MATRIX_BOT_SELECTION } from "../../../packages/gateway/src/bots/selection.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { Kysely } from "kysely";
import { BOT, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_uncertain_steer", RUN = "run_uncertain_steer", RUNTIME = `runtime_${"c".repeat(32)}`;
const ROUTE: BotModelRoute = { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 };

it.each(["unavailable", "disconnected", "missing_ack", "accepted", "refused"] as const)("keeps Bot upload lifetime tied to explicit worker acknowledgement: %s", async outcome => {
  const { db, destroy } = await createBotStateDatabase();
  const home = await mkdtemp(join(tmpdir(), "bot-steer-unknown-"));
  const held = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>();
  let running: ReturnType<ReturnType<typeof createBotTaskOrchestrator>["start"]> | undefined;
  try {
    await mkdir(join(home, "temporary/desktop-chat"), { recursive: true });
    await writeFile(join(home, "temporary/desktop-chat/file"), "BOT_STEER_MARKER");
    await insertChat(db, CHAT);
    const bindings = createBotBindingsRepository(db);
    await bindings.bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: new Date().toISOString() });
    const registry = new BotRuntimeRegistry();
    let alias = "";
    const runBot = vi.fn(async (input: { command: { kind: string; text?: string } }) => {
      if (input.command.kind === "bot.run") { ready.resolve(); await held.promise;
        return { ok: true as const, reply: { runId: RUN, status: "completed", toolActions: 0 } }; }
      alias = input.command.text!.match(/read_artifact path=(submitted-inputs\/[^;\s]+)/)![1]!;
      if (outcome === "unavailable") return { ok: false as const, error: "runtime_unavailable" };
      if (outcome === "disconnected") throw new Error("Synthetic disconnected socket");
      return { ok: true as const, reply: outcome === "missing_ack" ? {} : { acknowledged: outcome === "accepted" } };
    });
    const orchestrator = createBotTaskOrchestrator({ homePath: home, expectedOwnerId: OWNER, bindings,
      transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
      agents: { get: async () => ({ id: BOT, name: "Writing Bot", description: "", instructions: "Help revise essays.", archived: false,
        selection: MATRIX_BOT_SELECTION, recipeRef: { recipeId: "writing-bot", version: "2026-09-27.1" },
        revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) },
      recipes: createBotRecipeCatalog(), resolveRoute: async () => ({ route: ROUTE, accessSourceId: "matrix_included" }),
      registry, admission: {
        admit: async input => { registry.bind({ ...input, runtimeHandle: RUNTIME, executionGeneration: "1", rootFingerprint: "a".repeat(64) });
          return { runtimeHandle: RUNTIME, executionGeneration: "1", rootFingerprint: "a".repeat(64) }; },
        release: async handle => { registry.release(handle); }, startRenewal: () => ({ stop: async () => {} }),
      }, client: { runBot: runBot as never },
    });
    running = orchestrator.start({ ownerId: OWNER, chatId: CHAT, runId: RUN, text: "Keep working.",
      parts: [{ type: "text", text: "Keep working." }], selection: MATRIX_BOT_SELECTION, signal: new AbortController().signal });
    await ready.promise;
    const binding = registry.lookupRun({ runtimeHandle: RUNTIME, executionGeneration: "1", runId: RUN })!;
    const parts: CanonicalChatMessagePart[] = [{ type: "attachment_reference", attachmentId: "att_correction", kind: "file",
      label: "marker.txt", mimeType: "text/plain", ownerReference: "temporary/desktop-chat/file" }];
    const steer = orchestrator.steer(RUN, "Inspect correction", parts);
    if (["unavailable", "disconnected", "missing_ack"].includes(outcome)) await expect(steer).rejects.toThrow();
    else expect(await steer).toBe(outcome === "accepted");
    if (outcome === "refused") await expect(orchestrator.readSubmittedArtifact(binding, { relPath: alias })).rejects.toThrow();
    else expect(await orchestrator.readSubmittedArtifact(binding, { relPath: alias })).toBe("BOT_STEER_MARKER");
    expect(runBot).toHaveBeenCalledTimes(2); // No automatic replay after an uncertain acknowledgement.
    held.resolve(); await running.result;
    await expect(orchestrator.readSubmittedArtifact(binding, { relPath: alias })).rejects.toThrow();
  } finally {
    held.resolve(); if (running) await running.result;
    await destroy(); await rm(home, { recursive: true, force: true });
  }
});
