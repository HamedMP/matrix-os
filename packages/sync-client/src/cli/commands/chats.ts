import { defineCommand } from "citty";
import { localChatDiscoverCommand } from "./local-chat-discover.js";
import { localChatImportCommand } from "./local-chat-import.js";
export const chatsCommand = defineCommand({
  meta: { name: "chats", description: "Manage Matrix Chats" },
  subCommands: { discover:localChatDiscoverCommand, import: defineCommand({
    meta: { name: "import", description: "Preview and import selected local transcript history with a private original archive" },
    subCommands: { codex: localChatImportCommand("codex"), claude: localChatImportCommand("claude") },
  }) },
});
