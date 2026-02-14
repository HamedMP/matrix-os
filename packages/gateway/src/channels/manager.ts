import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelId,
  ChannelMessage,
  ChannelReply,
} from "./types.js";

export interface ChannelManagerConfig {
  config: Partial<Record<ChannelId, ChannelConfig>>;
  adapters: Partial<Record<ChannelId, ChannelAdapter>>;
  onMessage: (msg: ChannelMessage) => void;
}

export interface ChannelManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(reply: ChannelReply): Promise<void>;
  status(): Record<string, string>;
}

export function createChannelManager(
  opts: ChannelManagerConfig,
): ChannelManager {
  const { config, adapters, onMessage } = opts;
  const started = new Set<ChannelId>();
  const errors = new Set<ChannelId>();

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
      const adapter = adapters[reply.channelId];
      if (adapter) {
        await adapter.send(reply);
      }
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
