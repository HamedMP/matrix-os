import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as ownerPersonality from "../../../packages/gateway/src/bots/owner-personality.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { OWNER, OTHER_OWNER } from "./bot-state-support.js";
import { personalityFixture as fixture } from "./personality-orchestration-support.js";

it("runs the actual canonical Matrix Bot with current saved SOUL through recipe orchestration, broker and Pi without losing history", async () => {
  const f = await fixture({ hold: true });
  await f.turn("Who are you? Remember this first question.");
  await vi.waitFor(() => expect(f.specs).toHaveLength(1));
  expect(f.specs[0]!.systemPrompt).toContain("Your conversational name is Rick");
  expect(f.specs[0]!.systemPrompt).toContain("Any write or send needs the owner's approval of the exact action first.");
  await f.save("Your conversational name is Cedar. Reply in one sentence.");
  expect(f.specs[0]!.systemPrompt).not.toContain("Cedar");
  f.release(); await f.wait();
  await f.turn("Continue our previous conversation."); await f.wait();
  expect(f.specs[1]!.systemPrompt).toContain("Your conversational name is Cedar");
  expect(f.specs[1]!.systemPrompt).not.toContain("Your conversational name is Rick");
  expect(f.agentPrompts).toEqual(f.specs.map(spec => spec.systemPrompt));
  expect(f.specs.map(spec => spec.capabilities)).toEqual([f.recipes.resolve({ recipeId: "matrix-bot", version: "2026-10-10.1" }).capabilities, f.specs[0]!.capabilities]);
  expect((await f.agents.get({ type: "personal", ownerId: OWNER }, f.created.agent.id))?.name).toBe("Matrix Bot");
  const transcript = JSON.stringify((await f.sessions.load({ ownerId: OWNER, botId: f.created.agent.id, chatId: f.created.chatId })).messages);
  expect(transcript).toContain("Remember this first question");
  expect(transcript).toContain("SYNTHETIC_REPLY_0");
  expect(transcript).toContain("Continue our previous conversation");
  expect(transcript).not.toContain("Your conversational name is Rick");
});

it.each([OTHER_OWNER, null])("never reads the host profile for foreign/unconfigured runtime owner %s", async runtimeOwnerId => {
  const f = await fixture({ runtimeOwnerId });
  await writeFile(join(f.home, "system/soul.md"), Buffer.from([0xff]));
  await f.turn("Who are you?"); await f.wait();
  expect(f.specs[0]!.systemPrompt).not.toContain("Rick");
  expect(f.runBot).toHaveBeenCalledOnce();
});

it.each(["Matrix Bot", "Rick"])("applies preferences while preserving a Writing Bot named %s", async name => {
  const f = await fixture();
  const writing = await f.create(name, { recipeId: "writing-bot", version: "2026-09-27.1" });
  await f.turn("Revise this paragraph.", writing.chatId); await f.wait(writing.chatId);
  expect(f.specs[0]!.systemPrompt).toContain("Your conversational name is Rick");
  expect(f.specs[0]!.systemPrompt).toContain("Keep your replies short");
  expect(f.specs[0]!.systemPrompt).toContain("Owner-saved general preferences");
  expect(f.specs[0]!.systemPrompt).toContain(`Retain your own name ${JSON.stringify(name)}`);
  expect(f.specs[0]!.systemPrompt).toContain("draft and revise writing");
  expect(f.agentPrompts[0]).toBe(f.specs[0]!.systemPrompt);
});

it("refuses an invalid canonical Matrix Bot profile before worker inference with a safe failure", async () => {
  const f = await fixture();
  await writeFile(join(f.home, "system/soul.md"), Buffer.from([0xff]));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await f.turn("Who are you?"); await f.wait();
  expect(f.runBot).not.toHaveBeenCalled();
  expect((await f.db.selectFrom("bot_tasks").select(["status", "blocked_reason"]).execute())[0]).toMatchObject({ status: "blocked", blocked_reason: "policy_denied" });
  expect(JSON.stringify(warn.mock.calls)).not.toContain(f.home);
});

it("does not read owner identity when the canonical direct binding becomes shared", async () => {
  const f = await fixture();
  const read = vi.spyOn(ownerPersonality, "readOwnerSoul");
  await f.db.updateTable("chats").set({ collaboration: JSON.stringify({ sharedScopeId: "shared_fixture" }) })
    .where("id", "=", f.created.chatId).execute();
  const handle = f.orchestrator.start({ ownerId: OWNER, chatId: f.created.chatId, runId: "run_shared_identity", text: "Who are you?", signal: new AbortController().signal });
  expect(await handle.result).toMatchObject({ status: "blocked", blockedReason: "policy_denied" });
  expect(read).not.toHaveBeenCalled();
  expect(f.runBot).not.toHaveBeenCalled();
});

it("uses the canonical recipe default for empty and missing SOUL", async () => {
  const f = await fixture();
  await f.save("  ");
  await f.turn("Who are you?"); await f.wait();
  await rm(join(f.home, "system/soul.md"));
  await f.turn("Continue."); await f.wait();
  expect(f.specs).toHaveLength(2);
  for (const spec of f.specs) {
    expect(spec.systemPrompt).toContain('You are "Matrix Bot"');
    expect(spec.systemPrompt).not.toContain("Owner-saved personality");
  }
});


it("resolves a canonical Anthropic phase through the actual Provider V3 model catalog and preserves its authority", async () => {
  const f = await fixture({ isolated: true, realResolver: true, realPostgres: Boolean(process.env.MATRIX_TEST_POSTGRES_URL) });
  await f.turn("Who are you?"); await f.wait();
  expect(f.specs).toHaveLength(1);
  expect(f.specs[0]).toMatchObject({ route: { api: "anthropic-messages", modelId: "claude-sonnet-5", maxOutputTokens: 256 },
    capabilities: [], isolatedTurn: { phaseId: "phase_canonical_1", target: { kind: "canonical_bot", botId: f.created.agent.id } } });
  await f.turn("Continue."); await f.wait();
  expect(f.specs).toHaveLength(2);
  expect(f.specs[1]).toMatchObject({ isolatedTurn: { phaseId: "phase_canonical_2" } });
  expect(JSON.stringify((await f.sessions.load({ ownerId: OWNER, botId: f.created.agent.id, chatId: f.created.chatId })).messages))
    .toContain("SYNTHETIC_REPLY_1");
  expect(f.registry.size).toBe(0);
});

it.each([2, 12])("keeps the isolated canonical Bot at one call with ordinary trusted cap %i and preserves its first-turn session", async maxInferenceCalls => {
  vi.stubEnv("MATRIX_BOT_MAX_INFERENCE_CALLS", String(maxInferenceCalls));
  const f = await fixture({ isolated: true });
  await f.turn("Who are you?"); await f.wait();
  expect(f.specs[0]).toMatchObject({ route: { maxOutputTokens: 256 }, capabilities: [], limits: { maxToolActions: 1, maxInferenceCalls: 1 },
    isolatedTurn: { phaseId: "phase_canonical_1", target: { kind: "canonical_bot", botId: f.created.agent.id,
      chatId: f.created.chatId, recipeRef: { recipeId: "matrix-bot", version: "2026-10-10.1" } } } });
  await f.turn("How will you help me?"); await f.wait();
  expect(f.specs[1]).toMatchObject({ isolatedTurn: { phaseId: "phase_canonical_2" } });
  const transcript = JSON.stringify((await f.sessions.load({ ownerId: OWNER, botId: f.created.agent.id, chatId: f.created.chatId })).messages);
  expect(transcript).toContain("Who are you?");
  expect(transcript).toContain("SYNTHETIC_REPLY_0");
  expect(transcript).toContain("How will you help me?");
  expect(transcript).toContain("SYNTHETIC_REPLY_1");
});


it.runIf(Boolean(process.env.MATRIX_TEST_POSTGRES_URL))("composes Settings SOUL, actual PostgreSQL canonical admission, registry, Unix worker SDK and pre-send consume for two genuine session turns", async () => {
  const f = await fixture({ isolated: true, realPostgres: true, unixSdk: true });
  await f.turn("Who are you?"); await f.wait();
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  await f.turn("How will you help me?"); await f.wait();
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  for (const body of f.inferenceBodies) {
    expect(body).toMatchObject({ model: "@cf/zai-org/glm-5.3-flash", max_completion_tokens: 256, stream: true });
    expect(body.tools ?? []).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(131072);
    expect(JSON.stringify(body)).toContain("Your conversational name is Rick");
  }
  const second = JSON.stringify(f.inferenceBodies[1]);
  expect(second).toContain("Who are you?"); expect(second).toContain("OFFLINE_SDK_REPLY_1"); expect(second).toContain("How will you help me?");
  const stored = JSON.stringify((await f.sessions.load({ ownerId: OWNER, botId: f.created.agent.id, chatId: f.created.chatId })).messages);
  expect(stored).toContain("OFFLINE_SDK_REPLY_2"); expect(stored).toContain("OFFLINE_SDK_REPLY_1");
  expect(f.registry.size).toBe(0);
});


it.runIf(Boolean(process.env.MATRIX_TEST_POSTGRES_URL))("consumes a canonical phase once across eight real pooled broker frames and retains no live registry after release", async () => {
  const f = await fixture({ isolated: true, realPostgres: true, unixSdk: true, duplicateFrames: true });
  await f.turn("Who are you?"); await f.wait();
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(f.brokerReplies.filter(reply => reply?.ok)).toHaveLength(1);
  expect(f.brokerReplies.filter(reply => reply?.error === "action_denied")).toHaveLength(7);
  expect(f.registry.size).toBe(0);
});

it.runIf(Boolean(process.env.MATRIX_TEST_POSTGRES_URL)).each(["owner", "machine", "slot", "credential", "epoch", "source", "expiry", "recipe", "binding", "task", "attempt", "shared"] as const)("refuses a canonical %s change after real registry claim and before outbound inference", async change => {
  const f = await fixture({ isolated: true, realPostgres: true, unixSdk: true, beforeInference: async c => {
    if (change === "owner") c.setIdentity({ ownerId: "user_foreign" });
    if (change === "machine") c.setIdentity({ machineId: "machine_foreign" });
    if (change === "slot") c.setIdentity({ runtimeSlot: "pv-1" });
    if (change === "credential") c.setIdentity({ credentialSha256: "d".repeat(64) });
    if (change === "epoch") c.setIdentity({ runtimeTokenEpoch: 3 });
    if (change === "source") c.setIdentity({ sourceSha: "c".repeat(40) });
    if (change === "expiry") c.setClock(new Date(Date.now() + 3600000));
    if (change === "recipe") await f.agents.update({ type: "personal", ownerId: OWNER }, f.created.agent.id, { baseRevision: f.created.agent.revision, archived: true });
    if (change === "binding") await c.db.updateTable("bot_chat_bindings").set({ removed_at: new Date().toISOString() }).where("chat_id", "=", c.binding.chatId).execute();
    if (change === "task") {
      const tasks = createBotTasksRepository(c.db), task = await tasks.get({ ownerId: OWNER, taskId: c.binding.taskId });
      await tasks.transition({ ownerId: OWNER, taskId: c.binding.taskId, baseRevision: task!.revision, to: "failed", now: new Date().toISOString() });
    }
    if (change === "attempt") await c.db.updateTable("chat_runs").set({ attempt: 2 }).where("id", "=", c.binding.runId).execute();
    if (change === "shared") await c.db.updateTable("chats").set({ collaboration: JSON.stringify({ mode: "shared", membership: { role: "owner", memberCount: 2 } }) }).where("id", "=", c.binding.chatId).execute();
  } });
  await f.turn("Who are you?"); await f.wait();
  expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(f.resolveCredentials).not.toHaveBeenCalled();
  expect(f.brokerReplies).toHaveLength(1);
  expect(f.brokerReplies[0]).toMatchObject({ ok: false, error: "action_denied" });
  expect(f.registry.size).toBe(0);
});

it.runIf(Boolean(process.env.MATRIX_TEST_POSTGRES_URL)).each(["capacity", "unknown", "abort"] as const)("never retries or restores a consumed canonical generation after %s", async finalFailure => {
  const f = await fixture({ isolated: true, realPostgres: true, unixSdk: true, duplicateFrames: true, finalFailure });
  await f.turn("Who are you?"); await f.wait();
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(f.brokerReplies.every(reply => !reply?.ok)).toBe(true);
  expect(f.brokerReplies.filter(reply => reply?.error === "action_denied")).toHaveLength(7);
  expect(f.registry.size).toBe(0);
});


it.runIf(Boolean(process.env.MATRIX_TEST_POSTGRES_URL))("never rebinds a spent canonical phase to a new real task/run/runtime", async () => {
  const f = await fixture({ isolated: true, realPostgres: true, unixSdk: true, reusePhase: true });
  await f.turn("Who are you?"); await f.wait();
  await f.turn("How will you help me?"); await f.wait();
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(f.runBot).toHaveBeenCalledTimes(1);
  expect(f.registry.size).toBe(0);
});
