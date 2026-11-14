/** Sends a scheduled job's message to the channel its `cron.json` target names. */
import { formatForChannel } from "../channels/format.js";
import type { ChannelManager } from "../channels/manager.js";
import type { CronJob } from "./types.js";

export function createCronChannelTrigger(options: {
  channelManager: Pick<ChannelManager, "send">;
  logBestEffortFailure(context: string, error: unknown): void;
}): (job: CronJob) => Promise<void> {
  return async (job) => {
    const channel = job.target?.channel;
    const chatId = job.target?.chatId;
    if (!channel || !chatId) return;
    try {
      // Scheduled messages name no owner; the push channel sends them to this computer's owner only.
      await options.channelManager.send({ channelId: channel, chatId, text: formatForChannel(channel, job.message) });
    } catch (err: unknown) {
      options.logBestEffortFailure(`Scheduled message to ${channel} failed`, err);
    }
  };
}
