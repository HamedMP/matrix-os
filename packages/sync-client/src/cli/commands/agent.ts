import { defineCommand } from "citty";
import { formatCliSuccess } from "../output.js";
import { scanAgentAuth } from "../agent-auth-scan.js";

export const agentCommand = defineCommand({
  meta: {
    name: "agent",
    description: "Configure Matrix coding agents",
  },
  subCommands: {
    auth: defineCommand({
      meta: { name: "auth", description: "Inspect local AI agent auth state" },
      subCommands: {
        scan: defineCommand({
          meta: { name: "scan", description: "Detect local AI agent credential files" },
          args: {
            json: { type: "boolean", required: false, default: false },
          },
          run: async ({ args }) => {
            const result = await scanAgentAuth();
            if (args.json === true) {
              console.log(formatCliSuccess({ providers: result.providers }));
              return;
            }
            console.log("Local AI agent auth:");
            for (const provider of result.providers) {
              const marker = provider.status === "found" ? "FOUND" : provider.status === "manual" ? "MANUAL" : "MISSING";
              const transfer = provider.transferable && provider.remotePath
                ? ` -> matrix upload --secret ${provider.localPath} ${provider.remotePath}`
                : "";
              console.log(`${marker} ${provider.provider}: ${provider.localPath}${transfer}`);
            }
          },
        }),
      },
      run: () => {
        console.log("Usage: matrix agent auth scan");
      },
    }),
  },
  run: () => {
    console.log("Usage: matrix agent auth scan");
  },
});
