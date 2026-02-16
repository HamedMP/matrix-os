import type { MatrixOSPluginApi } from "../../../packages/gateway/src/plugins/types.js";

export function register(api: MatrixOSPluginApi) {
  api.registerChannel({
    id: "example",

    async start(config: Record<string, unknown>) {
      api.logger.info("Example channel started");
    },

    async stop() {
      api.logger.info("Example channel stopped");
    },

    async send(reply: { channelId: string; chatId: string; text: string }) {
      api.logger.info(`Would send to ${reply.chatId}: ${reply.text}`);
    },

    onMessage: () => {},
  });
}
