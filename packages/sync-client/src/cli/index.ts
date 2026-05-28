import { createRequire } from "node:module";
import { defineCommand, runMain } from "citty";
import { conciseNonInteractiveHelp, resolveTuiLaunchMode } from "./tui/launch.js";
import { launchTui } from "./tui/app.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { syncCommand } from "./commands/sync.js";
import { peersCommand } from "./commands/peers.js";
import { shellCommand } from "./commands/shell.js";
import { profileCommand } from "./commands/profile.js";
import { doctorCommand } from "./commands/doctor.js";
import { instanceCommand } from "./commands/instance.js";
import { whoamiCommand } from "./commands/whoami.js";
import { statusCommand } from "./commands/status.js";
import { completionCommand } from "./commands/completion.js";
import { runCommand } from "./commands/run.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const main = defineCommand({
  meta: {
    name: "matrixos",
    version: pkg.version,
    description: "Matrix OS CLI — file sync, shell sessions, and instance access",
  },
  subCommands: {
    tui: defineCommand({
      meta: { name: "tui", description: "Open the Matrix OS terminal UI" },
      args: {
        noColor: { type: "boolean", required: false, default: false },
      },
      // NOTE: this subcommand exists for `matrix tui --help` output. Normal
      // interactive `matrix tui` launches are intercepted before citty runs.
      run: async ({ args }) => {
        await launchTui({ noColor: args.noColor === true });
      },
    }),
    login: loginCommand,
    logout: logoutCommand,
    sync: syncCommand,
    peers: peersCommand,
    shell: shellCommand,
    sh: shellCommand,
    profile: profileCommand,
    whoami: whoamiCommand,
    status: statusCommand,
    run: runCommand,
    doctor: doctorCommand,
    instance: instanceCommand,
    completion: completionCommand,
  },
});

const launchMode = resolveTuiLaunchMode({
  argv: process.argv.slice(2),
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
});

if (launchMode.mode === "tui") {
  await launchTui({ noColor: process.argv.includes("--no-color") });
} else if (launchMode.mode === "help") {
  console.log(conciseNonInteractiveHelp());
} else {
  runMain(main);
}
