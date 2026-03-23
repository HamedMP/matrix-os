import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createDispatcher, type Dispatcher, type BatchEntry, type DispatchContext } from "./dispatcher.js";
import { createWatcher, type Watcher } from "./watcher.js";
import { createPtyHandler, type PtyMessage } from "./pty.js";
import { createConversationStore, type ConversationStore } from "./conversations.js";
import { summarizeConversation, saveSummary } from "./conversation-summary.js";
import { extractMemoriesLocal } from "./memory-extractor.js";
import { resolveWithinHome } from "./path-security.js";
import { listDirectory } from "./files-tree.js";
import { createChannelManager, type ChannelManager } from "./channels/manager.js";
import { createOutboundQueue } from "./security/outbound-queue.js";
import { createTelegramAdapter, type TelegramAdapter } from "./channels/telegram.js";
import { createTelegramStream } from "./channels/telegram-stream.js";
import { createPushAdapter } from "./channels/push.js";
import { createSessionStore } from "./session-store.js";
import { formatForChannel } from "./channels/format.js";
import type { ChannelConfig, ChannelId } from "./channels/types.js";
import { createCronStore } from "./cron/store.js";
import { createCronService, type CronService } from "./cron/service.js";
import { createHeartbeatRunner, type HeartbeatRunner } from "./heartbeat/runner.js";
import {
  createHeartbeat,
  backupModule,
  restoreModule,
  checkModuleHealth,
  createWatchdog,
  createTask,
  listTasks,
  getTask,
  type Heartbeat,
  type Watchdog,
  type KernelEvent,
  loadHandle,
  createImageClient,
  createUsageTracker,
  createMemoryStore,
} from "@matrix-os/kernel";
import { createProvisioner } from "./provisioner.js";
import { authMiddleware } from "./auth.js";
import { securityHeadersMiddleware } from "./security/headers.js";
import { getSystemInfo } from "./system-info.js";
import { createInteractionLogger, type InteractionLogger } from "./logger.js";
import { createApprovalBridge, type ApprovalBridge } from "./approval.js";
import { DEFAULT_APPROVAL_POLICY, type ApprovalPolicy } from "@matrix-os/kernel";
import { listApps } from "./apps.js";
import { renameApp, deleteApp } from "./app-ops.js";
import {
  createPluginRegistry,
  loadAllPlugins,
  createHookRunner,
  type PluginRegistry,
  type HookRunner,
  type LoadedPlugin,
} from "./plugins/index.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createSocialRoutes, insertPost } from "./social.js";
import { createActivityService } from "./social-activity.js";
import type { WSContext } from "hono/ws";
import {
  metricsRegistry,
  httpRequestsTotal,
  httpRequestDuration,
  wsConnectionsActive,
  normalizePath,
} from "./metrics.js";
import { VoiceService } from "./voice/index.js";
import { CallManager } from "./voice/call-manager.js";
import { CallStore } from "./voice/call-store.js";
import { createVoiceRoutes } from "./voice/routes.js";
import { createWebhookRouter } from "./voice/webhook.js";
import { handleVoiceWsMessage } from "./voice/voice-ws.js";
import { MockProvider } from "./voice/providers/mock.js";
import { TwilioProvider } from "./voice/providers/twilio.js";
import type { VoiceCallProvider } from "./voice/providers/base.js";
import { VoiceConfigSchema } from "./voice/types.js";

export interface GatewayConfig {
  homePath: string;
  port?: number;
  model?: string;
  maxTurns?: number;
  syncReport?: { added: string[]; updated: string[]; skipped: string[] };
}

type ClientMessage =
  | { type: "message"; text: string; sessionId?: string; requestId?: string }
  | { type: "switch_session"; sessionId: string }
  | { type: "approval_response"; id: string; approved: boolean };

export type ServerMessage =
  | { type: "kernel:init"; sessionId: string; requestId?: string }
  | { type: "kernel:text"; text: string; requestId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string }
  | { type: "kernel:result"; data: unknown; requestId?: string }
  | { type: "kernel:error"; message: string; requestId?: string }
  | { type: "file:change"; path: string; event: string }
  | { type: "task:created"; task: { id: string; type: string; status: string; input: string } }
  | { type: "task:updated"; taskId: string; status: string }
  | { type: "provision:start"; appCount: number }
  | { type: "provision:complete"; total: number; succeeded: number; failed: number }
  | { type: "session:switched"; sessionId: string }
  | { type: "approval:request"; id: string; toolName: string; args: unknown; timeout: number }
  | { type: "os:sync-report"; payload: { added: string[]; updated: string[]; skipped: string[] } }
  | { type: "data:change"; app: string; key: string };

function kernelEventToServerMessage(event: KernelEvent, requestId?: string): ServerMessage {
  switch (event.type) {
    case "init":
      return { type: "kernel:init", sessionId: event.sessionId, requestId };
    case "text":
      return { type: "kernel:text", text: event.text, requestId };
    case "tool_start":
      return { type: "kernel:tool_start", tool: event.tool, requestId };
    case "tool_end":
      return { type: "kernel:tool_end", input: event.input, requestId };
    case "result":
      return { type: "kernel:result", data: event.data, requestId };
  }
}

function send(ws: WSContext, msg: ServerMessage) {
  ws.send(JSON.stringify(msg));
}

export async function createGateway(config: GatewayConfig) {
  const { homePath: rawHomePath, port = 4000, syncReport } = config;
  const homePath = resolve(rawHomePath);
  let syncReportSent = false;

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const dispatcher: Dispatcher = createDispatcher({
    homePath,
    model: config.model,
    maxTurns: config.maxTurns,
  });

  const watcher: Watcher = createWatcher(homePath);
  const conversations: ConversationStore = createConversationStore(homePath);
  const clients = new Set<WSContext>();

  function logHealing(message: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [heal] ${message}\n`;
    const logPath = join(homePath, "system/activity.log");
    try { appendFileSync(logPath, line); } catch { /* log dir may not exist yet */ }
  }

  function broadcast(msg: ServerMessage) {
    const json = JSON.stringify(msg);
    for (const ws of clients) {
      ws.send(json);
    }
  }

  function broadcastError(message: string) {
    broadcast({ type: "kernel:error", message });
  }

  function finalizeWithSummary(sid: string) {
    conversations.finalize(sid);
    try {
      const conv = conversations.get(sid);
      if (conv && conv.messages.length > 0) {
        const summary = summarizeConversation({ id: conv.id, messages: conv.messages });
        if (summary) saveSummary(homePath, sid, summary);

        const candidates = extractMemoriesLocal(
          conv.messages.map((m) => ({ role: m.role, content: m.content })),
        );
        if (candidates.length > 0) {
          try {
            const memStore = createMemoryStore(dispatcher.db);
            for (const c of candidates) {
              memStore.remember(c.content, { source: sid, category: c.category });
            }
          } catch { /* memory extraction is best-effort */ }
        }
      }
    } catch { /* summary is best-effort */ }
  }

  const heartbeat: Heartbeat = createHeartbeat({
    homePath,
    onHealthFailure: async (target, error) => {
      const modulePath = join(homePath, "modules", target.name);

      logHealing(`Module "${target.name}" failed health checks: ${error}`);
      broadcastError(`Module "${target.name}" is unhealthy: ${error}. Attempting auto-heal...`);

      backupModule(homePath, target.name, modulePath);

      const healPrompt =
        `[HEAL] Module "${target.name}" has failed health checks. ` +
        `Error: ${error}. Port: ${target.port}. Path: ${modulePath}. ` +
        `Health endpoint: ${target.healthPath}. ` +
        `A backup has been created at ${join(homePath, ".backup", target.name)}. ` +
        `Diagnose and fix the issue.`;

      try {
        await dispatcher.dispatch(healPrompt, undefined, () => {});

        const result = await checkModuleHealth(target.port, target.healthPath, 5000);
        if (result.ok) {
          logHealing(`Module "${target.name}" healed successfully`);
          broadcastError(`Module "${target.name}" has been healed.`);
        } else {
          restoreModule(homePath, target.name, modulePath);
          logHealing(`Healing failed for "${target.name}": ${result.error}. Restored from backup.`);
          broadcastError(`Auto-heal failed for "${target.name}". Restored from backup.`);
        }
      } catch (err) {
        restoreModule(homePath, target.name, modulePath);
        const msg = err instanceof Error ? err.message : "Unknown error";
        logHealing(`Healing error for "${target.name}": ${msg}. Restored from backup.`);
        broadcastError(`Auto-heal error for "${target.name}": ${msg}. Restored from backup.`);
      }
    },
  });

  heartbeat.start();

  const watchdog: Watchdog = createWatchdog({
    homePath,
    onRevert: (commitMsg) => {
      logHealing(`Watchdog reverted evolver commit: ${commitMsg}`);
      broadcastError(`Evolver change reverted: ${commitMsg}`);
    },
  });

  // Channel manager -- reads config, starts enabled adapters
  const configPath = join(homePath, "system/config.json");
  let channelsConfig: Partial<Record<ChannelId, ChannelConfig>> = {};
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      channelsConfig = cfg.channels ?? {};
    }
  } catch { /* no channel config */ }

  const outboundQueue = createOutboundQueue(homePath);

  const pushAdapter = createPushAdapter();

  const channelSessions = createSessionStore(join(homePath, "system", "sessions.json"));

  const telegramAdapter: TelegramAdapter = createTelegramAdapter();

  const channelManager: ChannelManager = createChannelManager({
    config: channelsConfig,
    adapters: {
      telegram: telegramAdapter,
      push: pushAdapter,
    },
    outboundQueue,
    onMessage: (msg) => {
      const sessionKey = `${msg.source}:${msg.senderId}`;
      const existingSessionId = channelSessions.get(sessionKey);

      // Telegram streaming: use progressive message editing
      if (msg.source === "telegram") {
        const bot = telegramAdapter.getBot();
        if (bot) {
          const stream = createTelegramStream({
            chatId: msg.chatId,
            bot,
            throttleMs: 1000,
            minInitialChars: 50,
            maxChars: 4096,
          });

          stream.startTyping();

          const text = msg.text.startsWith("/") ? msg.text.slice(1) : msg.text;

          dispatcher
            .dispatch(text, existingSessionId, (event) => {
              if (event.type === "init") {
                channelSessions.set(sessionKey, event.sessionId, {
                  channel: msg.source, senderId: msg.senderId,
                  senderName: msg.senderName, chatId: msg.chatId,
                });
                conversations.begin(event.sessionId);
                conversations.addUserMessage(event.sessionId, msg.text);
              } else if (event.type === "text") {
                stream.append(event.text);
                const sid = channelSessions.get(sessionKey);
                if (sid) conversations.appendAssistantText(sid, event.text);
              } else if (event.type === "result") {
                const sid = channelSessions.get(sessionKey);
                if (sid) finalizeWithSummary(sid);
              }
            }, {
              channel: msg.source,
              senderId: msg.senderId,
              senderName: msg.senderName,
              chatId: msg.chatId,
            })
            .then(() => stream.flush())
            .catch((err: Error) => {
              stream.stopTyping();
              channelManager.send({
                channelId: msg.source,
                chatId: msg.chatId,
                text: `Error: ${err.message}`,
              });
            });

          return;
        }
      }

      // Default path for non-telegram channels (or telegram without bot)
      let responseText = "";

      dispatcher
        .dispatch(msg.text, existingSessionId, (event) => {
          if (event.type === "init") {
            channelSessions.set(sessionKey, event.sessionId, {
              channel: msg.source, senderId: msg.senderId,
              senderName: msg.senderName, chatId: msg.chatId,
            });
            conversations.begin(event.sessionId);
            conversations.addUserMessage(event.sessionId, msg.text);
          } else if (event.type === "text") {
            responseText += event.text;
            const sid = channelSessions.get(sessionKey);
            if (sid) conversations.appendAssistantText(sid, event.text);
          } else if (event.type === "result") {
            const sid = channelSessions.get(sessionKey);
            if (sid) finalizeWithSummary(sid);
          }
        }, {
          channel: msg.source,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
        })
        .then(() => {
          if (responseText) {
            const formatted = formatForChannel(msg.source, responseText);
            channelManager.send({
              channelId: msg.source,
              chatId: msg.chatId,
              text: formatted,
            });
          }
        })
        .catch((err: Error) => {
          channelManager.send({
            channelId: msg.source,
            chatId: msg.chatId,
            text: `Error: ${err.message}`,
          });
        });
    },
  });

  channelManager.start().then(() => {
    channelManager.replay().catch(() => {});

    // Register skills as Telegram slash commands
    const bot = telegramAdapter.getBot();
    if (bot?.setMyCommands) {
      try {
        const skillsDir = join(homePath, "agents", "skills");
        if (existsSync(skillsDir)) {
          const commands: Array<{ command: string; description: string }> = [];
          for (const f of readdirSync(skillsDir).filter((s) => s.endsWith(".md"))) {
            const content = readFileSync(join(skillsDir, f), "utf-8");
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            const descMatch = content.match(/^description:\s*(.+)$/m);
            if (nameMatch) {
              commands.push({
                command: nameMatch[1].trim().replace(/\s+/g, "-").toLowerCase(),
                description: (descMatch?.[1]?.trim() ?? nameMatch[1].trim()).slice(0, 256),
              });
            }
          }
          if (commands.length > 0) {
            bot.setMyCommands(commands.slice(0, 100)).catch(() => {});
          }
        }
      } catch { /* best-effort */ }
    }
  });

  // Cron service -- scheduled tasks from ~/system/cron.json
  const cronStore = createCronStore(join(homePath, "system", "cron.json"));
  const cronService: CronService = createCronService({
    store: cronStore,
    onTrigger: (job) => {
      if (job.target?.channel && job.target?.chatId) {
        const formatted = formatForChannel(job.target.channel, job.message);
        channelManager.send({
          channelId: job.target.channel,
          chatId: job.target.chatId,
          text: formatted,
        });
      }
    },
  });
  cronService.start();

  // Heartbeat runner -- periodic kernel invocation
  let heartbeatConfig: { everyMinutes?: number; activeHours?: { start: string; end: string } } = {};
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      heartbeatConfig = cfg.heartbeat ?? {};
    }
  } catch { /* no heartbeat config */ }

  const proactiveHeartbeat: HeartbeatRunner = createHeartbeatRunner({
    homePath,
    dispatcher,
    channelManager,
    everyMinutes: heartbeatConfig.everyMinutes,
    activeHours: heartbeatConfig.activeHours,
  });
  proactiveHeartbeat.start();

  let approvalPolicy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY;
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.approval) {
        approvalPolicy = { ...DEFAULT_APPROVAL_POLICY, ...cfg.approval };
      }
    }
  } catch { /* no approval config */ }

  const interactionLogger: InteractionLogger = createInteractionLogger(homePath);

  // Plugin system
  const pluginRegistry: PluginRegistry = createPluginRegistry();
  const hookRunner: HookRunner = createHookRunner(pluginRegistry);
  let loadedPlugins: LoadedPlugin[] = [];

  let pluginsConfig: { list?: string[]; configs?: Record<string, Record<string, unknown>> } = {};
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      pluginsConfig = cfg.plugins ?? {};
    }
  } catch { /* no plugins config */ }

  // Voice service -- TTS/STT with fallback chain
  let voiceConfig: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      voiceConfig = cfg.voice ?? {};
    }
  } catch { /* no voice config */ }

  const voiceService = VoiceService.create(voiceConfig);

  // Telephony: CallManager + CallStore + webhook/REST routes
  const callManager = new CallManager();
  const callStore = new CallStore(join(homePath, "system", "voice", "calls.jsonl"));
  const voiceProviders = new Map<string, VoiceCallProvider>();
  if (process.env.NODE_ENV === "test") {
    voiceProviders.set("mock", new MockProvider());
  }

  // Register TwilioProvider when credentials are available
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
      const twilioProvider = new TwilioProvider({
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        fromNumber: process.env.TWILIO_FROM_NUMBER || "+10000000000",
        publicUrl: process.env.MATRIX_VOICE_WEBHOOK_URL,
      });
      voiceProviders.set("twilio", twilioProvider);

      const parsedVoiceConfig = VoiceConfigSchema.parse(voiceConfig);
      callManager.initialize(twilioProvider, parsedVoiceConfig);
      console.log("[voice] Twilio provider registered and CallManager initialized");
    } catch (e) {
      console.warn("[voice] Failed to initialize Twilio provider:", e instanceof Error ? e.message : String(e));
    }
  }

  // Wire CallStore persistence: persist call records on creation
  const originalInitiateCall = callManager.initiateCall.bind(callManager);
  callManager.initiateCall = async (...args) => {
    const record = await originalInitiateCall(...args);
    callStore.append(record);
    return record;
  };

  const originalProcessEvent = callManager.processEvent.bind(callManager);
  callManager.processEvent = (callId, event) => {
    originalProcessEvent(callId, event);
    const call = callManager.getCall(callId);
    if (call) {
      try { callStore.update(callId, call); } catch { /* best effort */ }
    }
  };

  // CallManager is exposed via the voiceService return value from createGateway.
  // Kernel IPC tools receive it through VoiceToolDeps injection at startup.

  const provisioner = createProvisioner({
    homePath,
    dispatcher,
    broadcast,
  });

  watcher.on((change) => {
    broadcast(change);
    if (change.path === "system/setup-plan.json") {
      provisioner.onSetupPlanChange().catch((err: Error) => {
        broadcastError(`Provisioning error: ${err.message}`);
      });
    }
    if (change.path === "system/cron.json") {
      cronService.stop();
      cronService.start();
    }
  });

  app.use("*", cors());
  app.use("*", securityHeadersMiddleware());
  app.use("*", authMiddleware(process.env.MATRIX_AUTH_TOKEN));

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const duration = (performance.now() - start) / 1000;
    const path = normalizePath(c.req.path);
    const method = c.req.method;
    const status = String(c.res.status);
    httpRequestsTotal.inc({ method, path, status });
    httpRequestDuration.observe({ method, path }, duration);
  });

  app.get("/metrics", async (c) => {
    const output = await metricsRegistry.metrics();
    return c.text(output, 200, {
      "Content-Type": metricsRegistry.contentType,
    });
  });

  app.get(
    "/ws",
    upgradeWebSocket(() => {
      let pendingText: string | undefined;
      let activeSessionId: string | undefined;
      let approvalBridge: ApprovalBridge | undefined;

      return {
        onOpen(_evt, ws) {
          clients.add(ws);
          wsConnectionsActive.inc();
          approvalBridge = createApprovalBridge({
            send: (msg) => send(ws, msg),
            timeout: approvalPolicy.timeout,
          });

          // T2093: Send sync report once per boot
          if (syncReport && !syncReportSent) {
            syncReportSent = true;
            send(ws, {
              type: "os:sync-report",
              payload: syncReport,
            });
          }
        },

        onMessage(evt, ws) {
          let parsed: ClientMessage;
          try {
            parsed = JSON.parse(
              typeof evt.data === "string" ? evt.data : "",
            ) as ClientMessage;
          } catch {
            send(ws, { type: "kernel:error", message: "Invalid JSON" });
            return;
          }

          if (parsed.type === "switch_session") {
            activeSessionId = parsed.sessionId;
            send(ws, { type: "session:switched", sessionId: parsed.sessionId });
            return;
          }

          if (parsed.type === "approval_response" && approvalBridge) {
            approvalBridge.handleResponse({ id: parsed.id, approved: parsed.approved });
            return;
          }

          if (parsed.type === "message") {
            pendingText = parsed.text;
            const requestId = parsed.requestId;

            dispatcher
              .dispatch(parsed.text, parsed.sessionId, (event) => {
                const msg = kernelEventToServerMessage(event, requestId);
                send(ws, msg);

                if (msg.type === "kernel:init") {
                  activeSessionId = msg.sessionId;
                  conversations.begin(msg.sessionId);
                  if (pendingText) {
                    conversations.addUserMessage(msg.sessionId, pendingText);
                    pendingText = undefined;
                  }
                } else if (msg.type === "kernel:text" && activeSessionId) {
                  conversations.appendAssistantText(activeSessionId, msg.text);
                } else if (msg.type === "kernel:result" && activeSessionId) {
                  finalizeWithSummary(activeSessionId);
                }
              })
              .catch((err: Error) => {
                if (activeSessionId) {
                  finalizeWithSummary(activeSessionId);
                }
                send(ws, {
                  type: "kernel:error",
                  message: err.message ?? "Kernel error",
                  requestId,
                });
              });
          }
        },

        onClose(_evt, ws) {
          clients.delete(ws);
          wsConnectionsActive.dec();
        },
      };
    }),
  );

  app.get(
    "/ws/terminal",
    upgradeWebSocket((c) => {
      const cwdParam = c.req.query("cwd");
      const resolvedCwd = cwdParam ? resolveWithinHome(homePath, cwdParam) : null;
      const pty = createPtyHandler(homePath, undefined, resolvedCwd ?? undefined);

      return {
        onOpen(_evt, ws) {
          pty.onSend((msg) => {
            ws.send(JSON.stringify(msg));
          });
          pty.open();
        },

        onMessage(evt, _ws) {
          try {
            const msg = JSON.parse(
              typeof evt.data === "string" ? evt.data : "",
            ) as PtyMessage;
            pty.onMessage(msg);
          } catch {
            // ignore malformed
          }
        },

        onClose() {
          pty.close();
        },
      };
    }),
  );

  app.get("/api/files/tree", async (c) => {
    const pathParam = c.req.query("path") ?? "";
    const result = await listDirectory(homePath, pathParam);
    if (!result) {
      return c.json({ error: "Invalid path" }, 400);
    }
    return c.json(result);
  });

  app.get("/api/terminal/layout", async (c) => {
    const layoutPath = join(homePath, "system", "terminal-layout.json");
    try {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(layoutPath, "utf-8");
      return c.json(JSON.parse(data));
    } catch {
      return c.json({});
    }
  });

  app.put("/api/terminal/layout", async (c) => {
    const layoutPath = join(homePath, "system", "terminal-layout.json");
    const raw = await c.req.text();
    if (raw.length > 100_000) {
      return c.json({ error: "Payload too large" }, 413);
    }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return c.json({ error: "Invalid JSON" }, 400); }
    if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>).tabs)) {
      return c.json({ error: "Invalid layout schema" }, 400);
    }
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(dirname(layoutPath), { recursive: true });
      await writeFile(layoutPath, JSON.stringify(body, null, 2));
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Failed to save layout" }, 500);
    }
  });

  // Voice WebSocket: receives audio, returns transcription + TTS audio
  const MAX_VOICE_BUFFER_SIZE = 25 * 1024 * 1024; // 25MB
  app.get(
    "/ws/voice",
    upgradeWebSocket(() => {
      const chunks: Buffer[] = [];
      let collecting = false;
      let totalSize = 0;
      let processing = false;

      function createVoiceWsCtx(ws: WSContext) {
        return {
          voiceService,
          send: (data: string) => ws.send(data),
          dispatch: async (text: string) => {
            let responseText = "";
            await dispatcher.dispatch(text, undefined, (event) => {
              if (event.type === "text") {
                responseText += event.text;
              }
            }, { channel: "voice" });
            return responseText;
          },
        };
      }

      function processAudio(ws: WSContext, audioBuffer: Buffer) {
        if (processing) {
          ws.send(JSON.stringify({ type: "voice_error", message: "Still processing previous audio" }));
          return;
        }
        processing = true;
        handleVoiceWsMessage(createVoiceWsCtx(ws), audioBuffer)
          .catch(() => {
            ws.send(JSON.stringify({ type: "voice_error", message: "Voice processing error" }));
          })
          .finally(() => { processing = false; });
      }

      return {
        onMessage(evt, ws) {
          if (typeof evt.data === "string") {
            try {
              const msg = JSON.parse(evt.data);
              if (msg.type === "audio_start") {
                chunks.length = 0;
                totalSize = 0;
                collecting = true;
                return;
              }
              if (msg.type === "audio_end") {
                collecting = false;
                const audioBuffer = Buffer.concat(chunks);
                chunks.length = 0;
                totalSize = 0;
                processAudio(ws, audioBuffer);
                return;
              }
              if (msg.type === "voice" && msg.audio) {
                if (typeof msg.audio !== "string" || msg.audio.length > MAX_VOICE_BUFFER_SIZE * 1.37) {
                  ws.send(JSON.stringify({ type: "voice_error", message: "Audio too large" }));
                  return;
                }
                processAudio(ws, Buffer.from(msg.audio, "base64"));
                return;
              }
            } catch {
              ws.send(JSON.stringify({ type: "voice_error", message: "Invalid message" }));
            }
          } else if (collecting && (evt.data instanceof ArrayBuffer || evt.data instanceof Uint8Array)) {
            const chunk = Buffer.from(evt.data as ArrayBuffer);
            totalSize += chunk.length;
            if (totalSize > MAX_VOICE_BUFFER_SIZE) {
              collecting = false;
              chunks.length = 0;
              totalSize = 0;
              ws.send(JSON.stringify({ type: "voice_error", message: "Audio buffer size limit exceeded" }));
              ws.close(1009, "Buffer size limit exceeded");
              return;
            }
            chunks.push(chunk);
          }
        },

        onClose() {
          chunks.length = 0;
          totalSize = 0;
        },
      };
    }),
  );

  app.post("/api/message", async (c) => {
    const body = await c.req.json<{
      text: string;
      sessionId?: string;
      from?: { handle: string; displayName?: string };
    }>();
    const events: KernelEvent[] = [];

    const context: DispatchContext | undefined = body.from
      ? { senderId: body.from.handle, senderName: body.from.displayName ?? body.from.handle }
      : undefined;

    await dispatcher.dispatch(body.text, body.sessionId, (event) => {
      events.push(event);
    }, context);

    return c.json({ events });
  });

  app.on("HEAD", "/files/*", (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveWithinHome(homePath, filePath);
    if (!fullPath) return c.text("Forbidden", 403);
    if (!existsSync(fullPath)) return c.text("Not found", 404);
    if (statSync(fullPath).isDirectory()) return c.text("Is a directory", 400);
    return c.body(null, 200);
  });

  app.get("/files/*", (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveWithinHome(homePath, filePath);

    if (!fullPath) {
      return c.text("Forbidden", 403);
    }

    if (!existsSync(fullPath)) {
      return c.text("Not found", 404);
    }

    if (statSync(fullPath).isDirectory()) {
      return c.text("Is a directory", 400);
    }

    const ext = filePath.split(".").pop() ?? "";

    const textMimeTypes: Record<string, string> = {
      html: "text/html",
      json: "application/json",
      js: "application/javascript",
      css: "text/css",
      md: "text/markdown",
      txt: "text/plain",
    };

    const imageMimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
    };

    const binaryMimeTypes: Record<string, string> = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      webm: "audio/webm",
      m4a: "audio/mp4",
      flac: "audio/flac",
      opus: "audio/opus",
      pdf: "application/pdf",
    };

    if (imageMimeTypes[ext] || binaryMimeTypes[ext]) {
      const stat = statSync(fullPath);
      const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
      if (c.req.header("if-none-match") === etag) {
        return c.body(null, 304);
      }
      const buffer = readFileSync(fullPath);
      return c.body(buffer, 200, {
        "Content-Type": imageMimeTypes[ext] || binaryMimeTypes[ext],
        "Cache-Control": "public, max-age=86400, immutable",
        "CDN-Cache-Control": "public, max-age=86400",
        "ETag": etag,
      });
    }

    const content = readFileSync(fullPath, "utf-8");
    return c.body(content, 200, {
      "Content-Type": textMimeTypes[ext] ?? "text/plain",
    });
  });

  app.put("/files/*", async (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveWithinHome(homePath, filePath);
    if (!fullPath) return c.text("Invalid path", 403);
    const content = await c.req.text();
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
    return c.json({ ok: true });
  });

  app.post("/api/bridge/data", async (c) => {
    const body = await c.req.json<{
      action: "read" | "write";
      app: string;
      key: string;
      value?: string;
    }>();

    const safeApp = body.app.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeKey = body.key.replace(/[^a-zA-Z0-9_-]/g, "");
    const dataDir = join(homePath, "data", safeApp);
    const filePath = normalize(join(dataDir, `${safeKey}.json`));

    if (!filePath.startsWith(normalize(dataDir))) {
      return c.json({ error: "Path traversal denied" }, 403);
    }

    if (body.action === "read") {
      if (!existsSync(filePath)) return c.json({ value: null });
      const content = readFileSync(filePath, "utf-8");
      // Handle legacy double-encoded files (old bridge used JSON.stringify on write)
      let value = content;
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed === "string") {
          value = parsed;
        }
      } catch {
        // Not JSON, return raw content as-is
      }
      return c.json({ value });
    }

    mkdirSync(dataDir, { recursive: true });
    const raw = body.value ?? "";
    writeFileSync(filePath, typeof raw === "string" ? raw : String(raw), "utf-8");
    broadcast({ type: "data:change", app: safeApp, key: safeKey });
    return c.json({ ok: true });
  });

  app.get("/api/conversations", (c) => {
    return c.json(conversations.list());
  });

  app.post("/api/conversations", async (c) => {
    const body = await c.req.json<{ channel?: string }>().catch((): { channel?: string } => ({}));
    const id = conversations.create(body.channel);
    return c.json({ id }, 201);
  });

  app.delete("/api/conversations/:id", (c) => {
    const id = c.req.param("id");
    const deleted = conversations.delete(id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/conversations/:id/search", (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "q parameter required" }, 400);
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const results = conversations.search(query, { limit });
    return c.json(results);
  });

  app.get("/api/layout", (c) => {
    const layoutPath = join(homePath, "system/layout.json");
    if (!existsSync(layoutPath)) {
      return c.json({});
    }
    try {
      const data = JSON.parse(readFileSync(layoutPath, "utf-8"));
      return c.json(data);
    } catch {
      return c.json({});
    }
  });

  app.put("/api/layout", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || typeof body !== "object" || !Array.isArray(body.windows)) {
      return c.json({ error: "Invalid layout: requires windows array" }, 400);
    }
    const layoutPath = join(homePath, "system/layout.json");
    writeFileSync(layoutPath, JSON.stringify(body, null, 2));
    return c.json({ ok: true });
  });

  app.get("/api/canvas", (c) => {
    const canvasPath = join(homePath, "system/canvas.json");
    if (!existsSync(canvasPath)) {
      return c.json({});
    }
    try {
      const data = JSON.parse(readFileSync(canvasPath, "utf-8"));
      return c.json(data);
    } catch {
      return c.json({});
    }
  });

  app.put("/api/canvas", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || typeof body !== "object" || !body.transform) {
      return c.json({ error: "Invalid canvas data: requires transform object" }, 400);
    }
    const canvasPath = join(homePath, "system/canvas.json");
    writeFileSync(canvasPath, JSON.stringify(body, null, 2));
    return c.json({ ok: true });
  });

  app.get("/api/theme", (c) => {
    const themePath = join(homePath, "system/theme.json");
    if (!existsSync(themePath)) {
      return c.json({ error: "No theme" }, 404);
    }
    const theme = JSON.parse(readFileSync(themePath, "utf-8"));
    return c.json(theme);
  });

  app.all("/modules/:name/*", async (c) => {
    const moduleName = c.req.param("name");
    const modulesPath = join(homePath, "system/modules.json");

    if (!existsSync(modulesPath)) {
      return c.text("No modules registered", 404);
    }

    const modules = JSON.parse(readFileSync(modulesPath, "utf-8")) as Array<{
      name: string;
      port: number;
      status: string;
    }>;

    const mod = modules.find((m) => m.name === moduleName);
    if (!mod) {
      return c.text(`Module "${moduleName}" not found`, 404);
    }

    const subPath = c.req.path.replace(`/modules/${moduleName}`, "") || "/";
    const targetUrl = `http://localhost:${mod.port}${subPath}`;

    const res = await fetch(targetUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD"
        ? c.req.raw.body
        : undefined,
    });

    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    });
  });

  app.get("/api/tasks", (c) => {
    const status = c.req.query("status");
    const tasks = listTasks(dispatcher.db, status ? { status } : undefined);
    return c.json(tasks);
  });

  app.post("/api/tasks", async (c) => {
    const body = await c.req.json<{ type?: string; input: string; priority?: number }>();
    if (!body.input || typeof body.input !== "string") {
      return c.json({ error: "input is required" }, 400);
    }
    const id = createTask(dispatcher.db, {
      type: body.type ?? "todo",
      input: body.input,
      priority: body.priority,
    });
    const task = getTask(dispatcher.db, id);
    broadcast({
      type: "task:created",
      task: { id, type: body.type ?? "todo", status: "pending", input: body.input },
    });
    return c.json({ id, task }, 201);
  });

  app.get("/api/tasks/:id", (c) => {
    const task = getTask(dispatcher.db, c.req.param("id"));
    if (!task) return c.json({ error: "Not found" }, 404);
    return c.json(task);
  });

  app.get("/api/apps", (c) => {
    return c.json(listApps(homePath));
  });

  app.put("/api/apps/:slug/rename", async (c) => {
    const slug = c.req.param("slug");
    const { name } = await c.req.json<{ name: string }>();
    const result = renameApp(homePath, slug, name);
    if (!result.success) {
      const status = result.error?.includes("not found") ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true, newSlug: result.newSlug });
  });

  app.delete("/api/apps/:slug", async (c) => {
    const slug = c.req.param("slug");
    const result = deleteApp(homePath, slug);
    if (!result.success) {
      const status = result.error?.includes("not found") ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true });
  });

  app.post("/api/apps/:slug/icon", async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const falKey = process.env.FAL_API_KEY ?? "";
    if (!falKey) {
      return c.json({ error: "FAL_API_KEY not configured" }, 503);
    }
    try {
      let body: { style?: string } = {};
      try { body = await c.req.json(); } catch { /* no body is fine */ }

      let iconStyle = body.style ?? "";
      if (!iconStyle) {
        try {
          const desktop = JSON.parse(readFileSync(join(homePath, "system/desktop.json"), "utf-8"));
          iconStyle = desktop.iconStyle ?? "";
        } catch { /* ignore */ }
      }
      if (!iconStyle) {
        iconStyle = "Realistic 3D rendered app icon, soft gradient background, subtle drop shadow, rounded square shape, Apple macOS style";
      }

      const client = createImageClient(falKey);
      const name = slug.replace(/-/g, " ").replace(/_/g, " ");
      const prompt = `App icon for '${name}': ${iconStyle}, no text, 1:1 square`;
      const iconsDir = join(homePath, "system/icons");
      const result = await client.generateImage(prompt, {
        model: "fal-ai/z-image/turbo",
        size: "square",
        imageDir: iconsDir,
        saveAs: `${slug}.png`,
      });
      return c.json({ iconUrl: `/files/system/icons/${slug}.png`, cost: result.cost });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`Icon generation failed for "${slug}":`, message);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/icons/regenerate-all", async (c) => {
    const falKey = process.env.FAL_API_KEY ?? "";
    if (!falKey) {
      return c.json({ error: "FAL_API_KEY not configured" }, 503);
    }

    let iconStyle = "";
    try {
      const desktop = JSON.parse(readFileSync(join(homePath, "system/desktop.json"), "utf-8"));
      iconStyle = desktop.iconStyle ?? "";
    } catch { /* ignore */ }
    if (!iconStyle) {
      iconStyle = "Realistic 3D rendered app icon, soft gradient background, subtle drop shadow, rounded square shape, Apple macOS style";
    }

    const iconsDir = join(homePath, "system/icons");
    if (!existsSync(iconsDir)) {
      return c.json({ regenerated: 0, failed: [] });
    }

    const pngFiles = readdirSync(iconsDir).filter((f: string) => f.endsWith(".png"));
    const client = createImageClient(falKey);
    let regenerated = 0;
    const failed: string[] = [];

    for (const file of pngFiles) {
      const slug = file.replace(/\.png$/, "");
      const name = slug.replace(/-/g, " ").replace(/_/g, " ");
      const prompt = `App icon for '${name}': ${iconStyle}, no text, 1:1 square`;
      try {
        await client.generateImage(prompt, {
          model: "fal-ai/z-image/turbo",
          size: "square",
          imageDir: iconsDir,
          saveAs: `${slug}.png`,
        });
        regenerated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`Icon regeneration failed for "${slug}":`, msg);
        failed.push(slug);
      }
    }

    return c.json({ regenerated, failed });
  });

  app.get("/api/cron", (c) => {
    return c.json(cronService.listJobs());
  });

  app.post("/api/cron", async (c) => {
    const body = await c.req.json<{
      name: string;
      message: string;
      schedule: { type: string; intervalMs?: number; cron?: string; at?: string };
      target?: { channel: string; chatId: string };
    }>();
    if (!body.name || !body.message || !body.schedule?.type) {
      return c.json({ error: "name, message, and schedule.type are required" }, 400);
    }
    const { type } = body.schedule;
    let schedule: import("./cron/types.js").CronSchedule;
    if (type === "interval" && body.schedule.intervalMs) {
      schedule = { type: "interval", intervalMs: body.schedule.intervalMs };
    } else if (type === "cron" && body.schedule.cron) {
      schedule = { type: "cron", cron: body.schedule.cron };
    } else if (type === "once" && body.schedule.at) {
      schedule = { type: "once", at: body.schedule.at };
    } else {
      return c.json({ error: "Invalid schedule" }, 400);
    }
    const job: import("./cron/types.js").CronJob = {
      id: crypto.randomUUID(),
      name: body.name,
      message: body.message,
      schedule,
      target: body.target as import("./cron/types.js").CronTarget | undefined,
      createdAt: new Date().toISOString(),
    };
    cronService.addJob(job);
    return c.json(job, 201);
  });

  app.delete("/api/cron/:id", (c) => {
    const id = c.req.param("id");
    const removed = cronService.removeJob(id);
    if (!removed) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/channels/status", (c) => {
    return c.json(channelManager.status());
  });

  app.get("/api/identity", (c) => {
    return c.json(loadHandle(homePath));
  });

  app.get("/api/profile", (c) => {
    const profilePath = join(homePath, "system", "profile.md");
    if (!existsSync(profilePath)) return c.text("No profile", 404);
    return c.text(readFileSync(profilePath, "utf-8"));
  });

  app.get("/api/ai-profile", (c) => {
    const aiProfilePath = join(homePath, "system", "ai-profile.md");
    if (!existsSync(aiProfilePath)) return c.text("No AI profile", 404);
    return c.text(readFileSync(aiProfilePath, "utf-8"));
  });

  app.get("/api/logs", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    const source = c.req.query("source");
    const entries = interactionLogger.query({ date, source });
    return c.json({ entries, totalCost: interactionLogger.totalCost(date) });
  });

  app.get("/api/security/audit", async (c) => {
    const { runSecurityAudit } = await import("@matrix-os/kernel/security/audit");
    const report = await runSecurityAudit(homePath);
    return c.json(report);
  });

  app.get("/api/system/info", (c) => {
    const info = getSystemInfo(homePath);
    const today = new Date().toISOString().slice(0, 10);
    return c.json({ ...info, todayCost: interactionLogger.totalCost(today) });
  });

  app.post("/api/system/upgrade", async (c) => {
    const handle = process.env.MATRIX_HANDLE;
    const token = process.env.UPGRADE_TOKEN;
    const platformUrl = process.env.PLATFORM_INTERNAL_URL;

    if (!handle || !token || !platformUrl) {
      return c.json({ error: "Upgrade not configured" }, 503);
    }

    try {
      const res = await fetch(`${platformUrl}/containers/${handle}/self-upgrade`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return c.json({ error: (data as Record<string, string>).error ?? "Upgrade failed" }, res.status as 400);
      }

      return c.json({ ok: true });
    } catch {
      // Connection drop likely means the container is being replaced
      return c.json({ ok: true });
    }
  });

  const usageTracker = createUsageTracker(homePath);

  app.get("/api/usage", (c) => {
    try {
      const period = (c.req.query("period") ?? "daily") as string;
      const date = c.req.query("date") as string | undefined;
      const month = c.req.query("month") as string | undefined;

      if (period === "monthly") {
        return c.json(usageTracker.getMonthly(month));
      }
      return c.json(usageTracker.getDaily(date));
    } catch {
      return c.json({ total: 0, byAction: {} });
    }
  });

  app.post("/api/push/register", async (c) => {
    const body = await c.req.json<{ token: string; platform: string }>();
    if (!body.token || !body.platform) {
      return c.json({ error: "token and platform are required" }, 400);
    }
    pushAdapter.registerToken(body.token, body.platform);
    return c.json({ ok: true });
  });

  app.delete("/api/push/register", async (c) => {
    const body = await c.req.json<{ token: string }>();
    if (!body.token) {
      return c.json({ error: "token is required" }, 400);
    }
    pushAdapter.removeToken(body.token);
    return c.json({ ok: true });
  });

  // T978-T979: Settings API routes
  const settingsRoutes = createSettingsRoutes({ homePath, channelManager });
  app.route("/api/settings", settingsRoutes);

  // T2030-T2037: Social API routes
  const getCurrentUser = () => {
    const identity = loadHandle(homePath);
    return identity.handle || "@me";
  };
  const socialRoutes = createSocialRoutes(dispatcher.db, getCurrentUser);
  app.route("/api/social", socialRoutes);

  // T2036: Activity auto-posting
  const activityService = createActivityService({
    homePath,
    createPost: (post) => insertPost(dispatcher.db, post),
  });

  // T946: Plugin list endpoint
  app.get("/api/plugins", (c) => {
    return c.json(
      loadedPlugins.map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name ?? p.manifest.id,
        version: p.manifest.version ?? "0.0.0",
        description: p.manifest.description,
        origin: p.origin,
        status: p.status,
        error: p.error,
        contributions: pluginRegistry.getPluginContributions(p.manifest.id),
      })),
    );
  });

  // T2063: Leaderboard API routes
  const { getLeaderboard } = await import("./leaderboard.js");

  app.get("/api/games/leaderboard", (c) => {
    return c.json(getLeaderboard(homePath));
  });

  app.get("/api/games/leaderboard/:game", (c) => {
    const game = c.req.param("game");
    return c.json(getLeaderboard(homePath, game));
  });

  // Voice REST endpoints + webhook router
  app.route(
    "/api/voice",
    createVoiceRoutes({ voiceService, callStore, homePath }),
  );
  app.route(
    "/voice/webhook",
    createWebhookRouter({ callManager, providers: voiceProviders }),
  );

  app.get("/health", (c) => c.json({
    status: "ok",
    cronJobs: cronService.listJobs().length,
    channels: channelManager.status(),
    plugins: loadedPlugins.length,
  }));

  // Load plugins and mount their HTTP routes
  async function initPlugins() {
    try {
      loadedPlugins = await loadAllPlugins({
        homePath,
        configPaths: pluginsConfig.list,
        registry: pluginRegistry,
        systemConfig: {},
        pluginConfigs: pluginsConfig.configs,
      });

      // T944: Mount plugin HTTP routes
      for (const route of pluginRegistry.getRoutes()) {
        const fullPath = `/plugins/${route.pluginId}${route.path}`;
        const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch";
        app[method](fullPath, route.handler);
      }

      // T945: Start background services
      for (const svc of pluginRegistry.getServices()) {
        try {
          await svc.start();
        } catch (err) {
          console.error(`[plugin:${svc.pluginId}] Service ${svc.name} failed to start: ${err}`);
        }
      }

      // T939: Fire gateway_start hook
      await hookRunner.fireVoidHook("gateway_start", { port });
    } catch (err) {
      console.error("[plugins] Failed to initialize plugins:", err);
    }
  }

  await initPlugins().catch((err) => {
    console.error("[plugins] Plugin init error:", err);
  });

  const server = serve({ fetch: app.fetch, port });
  injectWebSocket(server);

  return {
    app,
    server,
    dispatcher,
    watcher,
    heartbeat,
    watchdog,
    channelManager,
    cronService,
    proactiveHeartbeat,
    pluginRegistry,
    hookRunner,
    voiceService,
    async close() {
      // T939: Fire gateway_stop hook
      await hookRunner.fireVoidHook("gateway_stop", {}).catch(() => {});

      // T945: Stop services in reverse order
      const services = pluginRegistry.getServices();
      for (let i = services.length - 1; i >= 0; i--) {
        try { await services[i].stop(); } catch { /* ignore */ }
      }

      voiceService.stop();
      heartbeat.stop();
      watchdog.stop();
      proactiveHeartbeat.stop();
      cronService.stop();
      await channelManager.stop();
      await watcher.close();
      server.close();
    },
  };
}
