import type { BotTaskSummary } from "@matrix-os/contracts";
import { latestBotTask } from "./bot-rail-status.js";
import { BotTaskStatus } from "./BotTaskStatus.js";

/** Historical attempts live in Details; terminal failures are rendered once by the transcript. */
export function BotCurrentTaskStatus({ tasks }: { tasks: readonly BotTaskSummary[] }) {
  const task = latestBotTask(tasks);
  return task && ["queued", "running", "waiting_person", "waiting_capacity"].includes(task.status) ? <BotTaskStatus task={task}/> : null;
}
