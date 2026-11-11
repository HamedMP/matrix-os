import { useEffect, useState } from "react";
import { z } from "zod/v4";

const apiPath = "/api/hosted-bots";
const botSummary = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
});
const bot = botSummary.extend({ revision: z.number(), instructions: z.string() });
const thread = z.object({ id: z.string().min(1), title: z.string(), updatedAt: z.string() });
const runMode = z.enum(["chat", "setup"]);
const run = z.object({
  id: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "failed"]),
  mode: runMode,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
const message = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.string(),
});
const roster = z.object({ bots: z.array(botSummary) });
const botDetails = z.object({ bot, threads: z.array(thread) });
const profileChange = z.object({
  id: z.string().min(1),
  reason: z.string(),
  revision: z.number(),
  undoneAt: z.string().nullable(),
});
const threadDetails = z.object({
  thread,
  messages: z.array(message),
  runs: z.array(run),
  profileChanges: z.array(profileChange),
});
const modelConnection = z.object({ connected: z.boolean() });

export interface HostedBotsTransport {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
}

export type HostedBot = z.infer<typeof bot>;
export type HostedBotSummary = z.infer<typeof botSummary>;
export type HostedBotThread = z.infer<typeof thread>;
export type HostedBotThreadDetails = z.infer<typeof threadDetails>;
export type HostedBotRun = z.infer<typeof run>;
export type HostedBotRunMode = z.infer<typeof runMode>;

export function createHostedBotsClient(transport: HostedBotsTransport) {
  const botPath = (botId: string) => apiPath + "/" + encodeURIComponent(botId);
  const threadPath = (botId: string, threadId: string) => botPath(botId) + "/threads/" + encodeURIComponent(threadId);
  return {
    async getModel() {
      return modelConnection.parse(await transport.get(apiPath + "/model"));
    },
    async connectModel(apiKey: string) {
      return modelConnection.parse(await transport.put(apiPath + "/model", { apiKey }));
    },
    async undo(botId: string, changeId: string) {
      const path = botPath(botId) + "/profile-changes/" + encodeURIComponent(changeId) + "/undo";
      return z.object({ bot }).parse(await transport.post(path, {})).bot;
    },
    async list() {
      return roster.parse(await transport.get(apiPath)).bots;
    },
    async createBot(name: string) {
      return z.object({ bot: botSummary }).parse(await transport.post(apiPath, { name })).bot;
    },
    async getBot(botId: string) {
      return botDetails.parse(await transport.get(botPath(botId)));
    },
    async createThread(botId: string) {
      return z.object({ thread }).parse(await transport.post(botPath(botId) + "/threads", {})).thread;
    },
    async getThread(botId: string, threadId: string) {
      return threadDetails.parse(await transport.get(threadPath(botId, threadId)));
    },
    async submit(botId: string, threadId: string, input: { requestId: string; text: string; mode: HostedBotRunMode }) {
      return z.object({ run }).parse(await transport.post(threadPath(botId, threadId) + "/runs", input)).run;
    },
  };
}

export function useHostedBotsAvailability(transport: HostedBotsTransport | null): boolean {
  const [admitted, setAdmitted] = useState<HostedBotsTransport | null>(null);
  useEffect(() => {
    if (!transport) return;
    let cancelled = false;
    void createHostedBotsClient(transport).list().then(() => {
      if (!cancelled) setAdmitted(transport);
    }, () => {
      if (!cancelled) setAdmitted(null);
    });
    return () => { cancelled = true; };
  }, [transport]);
  return transport !== null && admitted === transport;
}

export function isHostedBotRunActive(run: HostedBotRun) {
  return run.status === "queued" || run.status === "running";
}
