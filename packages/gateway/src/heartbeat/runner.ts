import { existsSync, readFileSync } from "node:fs";
import type { Dispatcher } from "../dispatcher.js";
import type { ChannelManager } from "../channels/manager.js";
import { buildHeartbeatPrompt } from "./prompt.js";
import type { CronJob } from "../cron/types.js";
import { formatForChannel } from "../channels/format.js";

export interface HeartbeatConfig {
  homePath: string;
  dispatcher: Dispatcher;
  channelManager?: ChannelManager;
  everyMinutes?: number;
  activeHours?: { start: string; end: string; timezone?: string };
}

export interface HeartbeatRunner {
  start(): void;
  stop(): void;
  runOnce(pendingEvents?: CronJob[]): Promise<void>;
}

/** Startup-only read of the `heartbeat` block in config.json; a missing or unreadable file yields defaults. */
export function readHeartbeatConfig(
  configPath: string,
  onError: (context: string, error: unknown) => void,
): Pick<HeartbeatConfig, "everyMinutes" | "activeHours"> {
  try {
    if (!existsSync(configPath)) return {};
    const heartbeat = JSON.parse(readFileSync(configPath, "utf-8")).heartbeat ?? {};
    return { everyMinutes: heartbeat.everyMinutes, activeHours: heartbeat.activeHours };
  } catch (err: unknown) {
    onError("Failed to load heartbeat config", err);
    return {};
  }
}

function isWithinActiveHours(
  activeHours: { start: string; end: string; timezone?: string },
): boolean {
  const now = new Date();
  const [startH, startM] = activeHours.start.split(":").map(Number);
  const [endH, endM] = activeHours.end.split(":").map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export function createHeartbeatRunner(config: HeartbeatConfig): HeartbeatRunner {
  const {
    homePath,
    dispatcher,
    channelManager,
    everyMinutes = 30,
    activeHours,
  } = config;

  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  async function runOnce(pendingEvents: CronJob[] = []): Promise<void> {
    if (activeHours && !isWithinActiveHours(activeHours)) return;

    const prompt = buildHeartbeatPrompt(homePath, pendingEvents);
    let responseText = "";

    await dispatcher.dispatch(prompt, undefined, (event) => {
      if (event.type === "text") {
        responseText += event.text;
      }
    }, { channel: undefined, senderId: "heartbeat", senderName: "heartbeat" }, undefined, { fundedRequestClass: "background" });

    if (
      responseText.trim() === "HEARTBEAT_OK" ||
      !responseText.trim()
    ) return;

    if (channelManager && pendingEvents.length > 0) {
      for (const event of pendingEvents) {
        if (event.target?.channel && event.target?.chatId) {
          const formatted = formatForChannel(event.target.channel, responseText);
          await channelManager.send({
            channelId: event.target.channel,
            chatId: event.target.chatId,
            text: formatted,
          });
        }
      }
    }
  }

  return {
    start() {
      if (intervalHandle) return;
      const intervalMs = everyMinutes * 60 * 1000;
      intervalHandle = setInterval(() => {
        runOnce().catch((err: unknown) => {
          console.warn("[heartbeat-runner] Scheduled heartbeat failed:", err instanceof Error ? err.message : String(err));
        });
      }, intervalMs);
    },

    stop() {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },

    runOnce,
  };
}
