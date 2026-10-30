import { BotInteractionError } from "./interactions.js";
import { createBotInteractionsRepository } from "./repositories/interactions.js";
import type { BotStateTransaction } from "./events.js";
import { createBotTasksRepository, type BotTask } from "./repositories/tasks.js";

/** One transaction decides whether this message continues a waiting task. */
export async function beginBotTask(tx: BotStateTransaction, input: {
  ownerId: string; botId: string; chatId: string; runId: string; now: string; text: string; backgroundTaskId?: string;
}): Promise<{ task: BotTask; continued: boolean }> {
  const tasks = createBotTasksRepository(tx.db);
  const admitted = await tx.db.selectFrom("chat_runs").innerJoin("chats", "chats.id", "chat_runs.chat_id")
    .select("chat_runs.client_request_id").where("chat_runs.id", "=", input.runId)
    .where("chat_runs.chat_id", "=", input.chatId).where("chats.owner_type", "=", "personal")
    .where("chats.owner_id", "=", input.ownerId).executeTakeFirst();
  if (input.backgroundTaskId) {
    const claimed = await tasks.get({ ownerId: input.ownerId, taskId: input.backgroundTaskId }, tx.db);
    if (!claimed || claimed.botId !== input.botId || claimed.chatId !== input.chatId
      || !(claimed.status === "queued" && !claimed.runId || claimed.status === "blocked" && claimed.blockedReason === "capacity_unavailable")) {
      throw new BotInteractionError("conflict");
    }
    const task = await tasks.transition({ ownerId: input.ownerId, taskId: claimed.taskId, baseRevision: claimed.revision,
      to: "running", runId: input.runId, now: input.now }, tx.db);
    await tx.publish(task.chatId, "bot.task.updated", { taskId: task.taskId, chatId: task.chatId, agentId: task.botId, status: task.status, revision: task.revision });
    return { task, continued: false };
  }
  let waiting: BotTask | undefined;
  if (admitted?.client_request_id.startsWith("req_answer_")) {
    const interactionId = admitted.client_request_id.slice("req_answer_".length);
    const interaction = await createBotInteractionsRepository(tx.db).get({ ownerId: input.ownerId, interactionId }, tx.db);
    if (!interaction || interaction.chatId !== input.chatId || interaction.botId !== input.botId
      || interaction.responderActorId !== input.ownerId || !interaction.blocking || interaction.status !== "resolved"
      || Date.parse(interaction.expiresAt) <= Date.parse(input.now)
      || interaction.resolution?.continuation !== input.text) throw new BotInteractionError("conflict");
    waiting = await tasks.get({ ownerId: input.ownerId, taskId: interaction.taskId }, tx.db);
    // A cancel or later task wins. Never treat an old answer as a new prompt.
    if (!waiting || waiting.chatId !== input.chatId || waiting.botId !== input.botId || waiting.status !== "waiting_person") {
      throw new BotInteractionError("conflict");
    }
    if ((interaction.kind === "question" && !interaction.sourceRunId)
      || (interaction.sourceRunId && waiting.runId !== interaction.sourceRunId)) throw new BotInteractionError("conflict");
  } else {
    waiting = (await tasks.listOpen({ ownerId: input.ownerId, botId: input.botId, chatId: input.chatId }, tx.db))
      .find(task => task.status === "waiting_person");
  }
  const base = waiting ?? await tasks.create({ ownerId: input.ownerId, botId: input.botId, chatId: input.chatId, now: input.now }, tx.db);
  const task = await tasks.transition({
    ownerId: input.ownerId, taskId: base.taskId, baseRevision: base.revision, to: "running", runId: input.runId, now: input.now,
  }, tx.db);
  await tx.publish(task.chatId, "bot.task.updated", { taskId: task.taskId, chatId: task.chatId, agentId: task.botId, status: task.status, revision: task.revision });
  return { task, continued: waiting !== undefined };
}
