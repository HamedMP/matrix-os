import { defineCommand } from "citty";
import { localChatDiscoverCommand } from "./local-chat-discover.js";
import { localChatImportCommand } from "./local-chat-import.js";
import { readChatCommand, sendChatCommand, watchChatCommand, exportChatCommand } from "./chat-operations.js";
export const chatsCommand = defineCommand({
  meta: { name: "chats", description: "Manage Matrix Chats" },
  subCommands: { read: readChatCommand, get: readChatCommand, send: sendChatCommand, watch: watchChatCommand, export: exportChatCommand,
    discover:localChatDiscoverCommand, import: defineCommand({
    meta: { name: "import", description: "Preview and import selected local transcript history with a private original archive" },
    subCommands: { codex: localChatImportCommand("codex"), claude: localChatImportCommand("claude") },
  }) },
});
