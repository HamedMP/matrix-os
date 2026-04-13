import { defineCommand } from "citty";
import { login } from "../../auth/oauth.js";
import { loadConfig } from "../../lib/config.js";

export const loginCommand = defineCommand({
  meta: { name: "login", description: "Log in to Matrix OS" },
  run: async () => {
    const config = await loadConfig();
    const platformUrl = config?.gatewayUrl ?? "https://matrix-os.com";

    console.log("Opening browser for authentication...");

    const auth = await login({
      platformUrl,
      clientId: "matrixos-cli",
    });

    console.log(`Logged in as ${auth.handle}`);
  },
});
