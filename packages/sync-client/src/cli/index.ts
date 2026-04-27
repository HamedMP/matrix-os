import { createRequire } from "node:module";
import { defineCommand, runMain } from "citty";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { syncCommand } from "./commands/sync.js";
import { peersCommand } from "./commands/peers.js";
import { keysCommand } from "./commands/keys.js";
import { sshCommand } from "./commands/ssh.js";
import { shellCommand } from "./commands/shell.js";
import { profileCommand } from "./commands/profile.js";
import { doctorCommand } from "./commands/doctor.js";
import { instanceCommand } from "./commands/instance.js";
import { whoamiCommand } from "./commands/whoami.js";
import { statusCommand } from "./commands/status.js";
import { completionCommand } from "./commands/completion.js";

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
    shell: shellCommand,
    sh: shellCommand,
    profile: profileCommand,
    whoami: whoamiCommand,
    status: statusCommand,
    doctor: doctorCommand,
    instance: instanceCommand,
    completion: completionCommand,
  },
});

runMain(main);
