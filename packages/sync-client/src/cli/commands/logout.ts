import { defineCommand } from "citty";
import { clearAuth } from "../../auth/token-store.js";

export const logoutCommand = defineCommand({
  meta: { name: "logout", description: "Log out of Matrix OS" },
  run: async () => {
    await clearAuth();
    console.log("Logged out.");
  },
});
