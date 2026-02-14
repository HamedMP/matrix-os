import type { ChannelId } from "../channels/types.js";

export type CronSchedule =
  | { type: "cron"; cron: string }
  | { type: "interval"; intervalMs: number }
  | { type: "once"; at: string };

export interface CronTarget {
  channel?: ChannelId;
  chatId?: string;
}

export interface CronJob {
  id: string;
  name: string;
  message: string;
  schedule: CronSchedule;
  target?: CronTarget;
  createdAt: string;
}
