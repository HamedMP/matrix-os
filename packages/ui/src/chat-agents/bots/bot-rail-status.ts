import { botInteractionCard, botTaskStatusCopy, type BotInteraction, type BotTaskSummary } from "@matrix-os/contracts";

export type BotRailStatus = {
  state: "loading" | "unavailable" | "idle" | "working" | "attention" | "completed";
  label: string;
};
export const BOT_RAIL_LOADING: BotRailStatus = { state: "loading", label: "Loading status…" };
export const BOT_RAIL_UNAVAILABLE: BotRailStatus = { state: "unavailable", label: "Status unavailable" };
export const BOT_RAIL_IDLE: BotRailStatus = { state: "idle", label: "No open tasks" };

export function latestBotTask(tasks: readonly BotTaskSummary[]): BotTaskSummary | undefined {
  // The contract accepts UTC timestamps both with and without milliseconds.
  return tasks.reduce<BotTaskSummary | undefined>((latest, candidate) => {
    const time = Date.parse(candidate.updatedAt);
    const latestTime = latest ? Date.parse(latest.updatedAt) : -Infinity;
    return !latest || time > latestTime || time === latestTime && candidate.taskId > latest.taskId ? candidate : latest;
  }, undefined);
}

/** Definition existence is not execution evidence. Only canonical task/interaction
 * state produces a colored indicator; an empty open-task snapshot stays neutral. */
export function botRailStatus(tasks: readonly BotTaskSummary[], interactions: readonly BotInteraction[], now: string): BotRailStatus {
  const nowTime = Date.parse(now);
  const pending = interactions.find(item => item.status === "pending" && Date.parse(item.expiresAt) > nowTime);
  if (pending) return { state: "attention", label: botInteractionCard(pending, now).title };
  const task = latestBotTask(tasks);
  if (!task) return BOT_RAIL_IDLE;
  const label = botTaskStatusCopy(task);
  switch (task.status) {
    case "running": return { state: "working", label };
    case "waiting_person": case "blocked": case "failed": return { state: "attention", label };
    case "completed": return { state: "completed", label };
    case "queued": case "waiting_capacity": case "cancelled": return { state: "idle", label };
  }
}
