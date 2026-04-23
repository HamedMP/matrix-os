import { createRequire } from "node:module";
import { defineCommand, runMain } from "citty";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { syncCommand } from "./commands/sync.js";
import { peersCommand } from "./commands/peers.js";
import { keysCommand } from "./commands/keys.js";
import { sshCommand } from "./commands/ssh.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const main = defineCommand({
  meta: {
    name: "matrixos",
    version: pkg.version,
    description: "Matrix OS CLI — file sync, sharing, and remote access",
  },
  subCommands: {
    login: loginCommand,
    logout: logoutCommand,
    sync: syncCommand,
    peers: peersCommand,
    keys: keysCommand,
    ssh: sshCommand,
  },
});

runMain(main);
