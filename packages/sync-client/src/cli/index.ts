import { basename } from "node:path";
import { defineCommand, runMain } from "citty";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { syncCommand } from "./commands/sync.js";
import { peersCommand } from "./commands/peers.js";
import { keysCommand } from "./commands/keys.js";
import { sshCommand } from "./commands/ssh.js";

// Build-time constant replaced by esbuild's --define. Falls back to "dev"
// when running from source (e.g. `pnpm tsx bin/...`).
declare const __MATRIX_CLI_VERSION__: string;
const version =
  typeof __MATRIX_CLI_VERSION__ === "string" ? __MATRIX_CLI_VERSION__ : "dev";

// Prefer the invoking alias (matrix/matrixos/mos) for help text. The POSIX
// wrapper sets MATRIX_CLI_NAME; when running directly (tsx/source), fall
// back to argv[1] stripped of its extension.
const invokedAs =
  process.env.MATRIX_CLI_NAME ??
  basename(process.argv[1] ?? "matrix").replace(/\.js$/, "");

const main = defineCommand({
  meta: {
    name: invokedAs || "matrix",
    version,
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
