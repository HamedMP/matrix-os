import type { BotTaskSummary } from "@matrix-os/contracts";
import { BotTaskStatus } from "./BotTaskStatus.js";

/** Historical attempts live in Details; terminal failures are rendered once by the transcript. */
export function BotCurrentTaskStatus({ tasks }: { tasks: readonly BotTaskSummary[] }) {
  const task = tasks.reduce<BotTaskSummary | undefined>((latest, candidate) =>
    !latest || candidate.updatedAt > latest.updatedAt || candidate.updatedAt === latest.updatedAt && candidate.taskId > latest.taskId ? candidate : latest, undefined);
  return task && ["queued", "running", "waiting_person", "waiting_capacity"].includes(task.status) ? <BotTaskStatus task={task}/> : null;
}
