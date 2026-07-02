import { defineCommand, runMain } from "citty";
import { loginCommand } from "./commands/login.js";
import { setupCommand } from "./commands/setup.js";
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
import { uploadCommand } from "./commands/upload.js";
import { downloadCommand } from "./commands/download.js";
import { agentCommand } from "./commands/agent.js";
import { devCommand } from "./commands/dev.js";
import { forwardAliasCommand, portCommand } from "./commands/port.js";
import { normalizeLeadingGlobalFlags } from "./global-flags.js";
import { shouldRunStandaloneDaemon } from "./standalone-runtime.js";
import { getCliTelemetry } from "./telemetry.js";
import { resolveCliVersion } from "./version.js";

const subCommands = {
  login: loginCommand,
  setup: setupCommand,
  logout: logoutCommand,
  sync: syncCommand,
  peers: peersCommand,
  shell: shellCommand,
  sh: shellCommand,
  profile: profileCommand,
  whoami: whoamiCommand,
  status: statusCommand,
  run: runCommand,
  upload: uploadCommand,
  download: downloadCommand,
  agent: agentCommand,
  dev: devCommand,
  port: portCommand,
  forward: forwardAliasCommand,
  doctor: doctorCommand,
  instance: instanceCommand,
  completion: completionCommand,
};

const main = defineCommand({
  meta: {
    name: "matrixos",
    version: resolveCliVersion(),
    description: "Matrix OS CLI — file sync, shell sessions, and instance access",
  },
  subCommands,
});

const rawArgs = normalizeLeadingGlobalFlags(process.argv.slice(2));

if (shouldRunStandaloneDaemon(rawArgs)) {
  const { startDaemon } = await import("../daemon/index.js");
  await startDaemon();
} else {
  // Anonymous usage telemetry (no-op without a PostHog token; opt out with
  // MATRIX_NO_TELEMETRY). Only the resolved command name and an argument count
  // are captured -- never argument values or paths. Unknown first tokens are
  // reported as "unknown" so typos cannot leak file names.
  const telemetry = getCliTelemetry();
  const firstPositional = rawArgs.find((arg) => !arg.startsWith("-"));
  const commandName = firstPositional
    ? Object.hasOwn(subCommands, firstPositional)
      ? firstPositional
      : "unknown"
    : "root";
  telemetry.captureCommandRun(commandName, Math.max(rawArgs.length - (firstPositional ? 1 : 0), 0));

  try {
    await runMain(main, { rawArgs });
  } finally {
    await telemetry.shutdown();
  }
}
