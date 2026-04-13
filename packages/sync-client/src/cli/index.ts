import { defineCommand, runMain } from "citty";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { syncCommand } from "./commands/sync.js";
import { peersCommand } from "./commands/peers.js";

const main = defineCommand({
  meta: {
    name: "matrixos",
    version: "0.0.1",
    description: "Matrix OS CLI — file sync, sharing, and remote access",
  },
  subCommands: {
    login: loginCommand,
    logout: logoutCommand,
    sync: syncCommand,
    peers: peersCommand,
  },
});

runMain(main);
