import type { MatrixOSPluginApi } from "../../../packages/gateway/src/plugins/types.js";

export function register(api: MatrixOSPluginApi) {
  api.registerTool({
    name: "greet",
    description: "Greet someone by name",
    schema: { name: { type: "string" } },
    execute: async (params) => ({
      content: [{ type: "text", text: `Hello, ${params.name ?? "world"}!` }],
    }),
  });

  api.registerHook("message_received", (ctx) => {
    api.logger.info(`Message received: ${JSON.stringify(ctx).slice(0, 100)}`);
  });

  api.registerHttpRoute({
    path: "/status",
    method: "GET",
    handler: async (c) => c.json({ plugin: "hello-world", status: "running" }),
  });
}
