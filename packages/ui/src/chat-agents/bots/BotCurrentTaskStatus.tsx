import type { BotTaskSummary } from "@matrix-os/contracts";
import { latestBotTask } from "./bot-rail-status.js";
import { BotTaskStatus } from "./BotTaskStatus.js";

/** Running progress lives in the canonical transcript; this body retains waits requiring attention. */
export function currentBotAttentionTask(tasks: readonly BotTaskSummary[]) {
  const task = latestBotTask(tasks);
  return task && ["waiting_person", "waiting_capacity"].includes(task.status) ? task : null;
}

export function BotCurrentTaskStatus({ tasks }: { tasks: readonly BotTaskSummary[] }) {
  const task = currentBotAttentionTask(tasks);
  return task ? <BotTaskStatus task={task}/> : null;
}
