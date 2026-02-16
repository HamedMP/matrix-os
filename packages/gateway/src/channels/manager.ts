import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelId,
  ChannelMessage,
  ChannelReply,
} from "./types.js";
import type { OutboundQueue } from "../security/outbound-queue.js";

export interface ChannelManagerConfig {
  config: Partial<Record<ChannelId, ChannelConfig>>;
  adapters: Partial<Record<ChannelId, ChannelAdapter>>;
  onMessage: (msg: ChannelMessage) => void;
  outboundQueue?: OutboundQueue;
}

export interface ChannelManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(reply: ChannelReply): Promise<void>;
  replay(): Promise<{ replayed: number; failed: number }>;
  restartChannel(id: ChannelId, newConfig: ChannelConfig): Promise<void>;
  status(): Record<string, string>;
}

export function createChannelManager(
  opts: ChannelManagerConfig,
): ChannelManager {
  const { config, adapters, onMessage, outboundQueue } = opts;
  const started = new Set<ChannelId>();
  const errors = new Set<ChannelId>();

  async function sendDirect(reply: ChannelReply): Promise<void> {
    const adapter = adapters[reply.channelId];
    if (adapter) {
      await adapter.send(reply);
    }
  }

  return {
    async start() {
      for (const [id, channelConfig] of Object.entries(config)) {
        const channelId = id as ChannelId;
        if (!channelConfig.enabled) continue;

        const adapter = adapters[channelId];
        if (!adapter) continue;

        adapter.onMessage = onMessage;

        try {
          await adapter.start(channelConfig);
          started.add(channelId);
        } catch {
          errors.add(channelId);
        }
      }
    },

    async restartChannel(id: ChannelId, newConfig: ChannelConfig) {
      const adapter = adapters[id];
      if (!adapter) return;

      if (started.has(id)) {
        await adapter.stop();
        started.delete(id);
      }
      errors.delete(id);
      config[id] = newConfig;

      if (!newConfig.enabled) return;

      adapter.onMessage = onMessage;
      try {
        await adapter.start(newConfig);
        started.add(id);
      } catch {
        errors.add(id);
      }
    },

    async stop() {
      for (const id of started) {
        const adapter = adapters[id];
        if (adapter) {
          await adapter.stop();
        }
      }
      started.clear();
    },

    async send(reply) {
      if (!outboundQueue) {
        return sendDirect(reply);
      }

      const msgId = outboundQueue.enqueue({
        channel: reply.channelId,
        target: reply.chatId,
        content: reply.text,
      });

      try {
        await sendDirect(reply);
        outboundQueue.ack(msgId);
      } catch (err) {
        outboundQueue.failed(msgId, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    async replay() {
      if (!outboundQueue) return { replayed: 0, failed: 0 };

      const pending = outboundQueue.pending();
      let replayed = 0;
      let failed = 0;

      for (const msg of pending) {
        try {
          await sendDirect({
            channelId: msg.channel as ChannelId,
            chatId: msg.target,
            text: msg.content,
          });
          outboundQueue.ack(msg.id);
          replayed++;
        } catch (err) {
          outboundQueue.failed(msg.id, err instanceof Error ? err.message : String(err));
          failed++;
        }
      }

      return { replayed, failed };
    },

    status() {
      const result: Record<string, string> = {};
      for (const [id, channelConfig] of Object.entries(config)) {
        const channelId = id as ChannelId;
        if (!adapters[channelId]) continue;

        if (errors.has(channelId)) {
          result[id] = "error";
        } else if (!channelConfig.enabled) {
          result[id] = "disabled";
        } else if (started.has(channelId)) {
          result[id] = "connected";
        } else {
          result[id] = "stopped";
        }
      }
      return result;
    },
  };
}
