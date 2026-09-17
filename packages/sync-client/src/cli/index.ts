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
import { mcpCommand } from "./commands/mcp.js";
import { runCommand } from "./commands/run.js";
import { uploadCommand } from "./commands/upload.js";
import { downloadCommand } from "./commands/download.js";
import { agentCommand } from "./commands/agent.js";
import { collaborationCommand } from "./commands/collaboration.js";
import { forwardAliasCommand, portCommand } from "./commands/port.js";
import { normalizeLeadingGlobalFlags } from "./global-flags.js";
import {
  shouldRunDesktopActivation,
  shouldRunDesktopEnrollment,
  shouldRunDesktopRevocation,
  shouldRunStandaloneDaemon,
} from "./standalone-runtime.js";
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
  collaboration: collaborationCommand,
  port: portCommand,
  forward: forwardAliasCommand,
  doctor: doctorCommand,
  instance: instanceCommand,
  completion: completionCommand,
  mcp: mcpCommand,
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
} else if (shouldRunDesktopEnrollment(rawArgs)) {
  const { runDesktopEnrollmentFromStdin } = await import("../auth/desktop-enrollment.js");
  try {
    await runDesktopEnrollmentFromStdin();
  } catch (err: unknown) {
    console.error(JSON.stringify({
      ok: false,
      error: err instanceof Error && [
        "desktop_enrollment_input_invalid",
        "desktop_enrollment_input_too_large",
        "desktop_enrollment_existing_mappings",
      ].includes(err.message)
        ? err.message
        : "desktop_enrollment_failed",
    }));
    process.exitCode = 1;
  }
} else if (shouldRunDesktopActivation(rawArgs)) {
  const { installService, startService, createStandaloneDaemonServiceCommand } = await import("../daemon/service.js");
  const { loadProfileSyncConfig } = await import("../lib/profile-sync-config.js");
  try {
    const resolution = await loadProfileSyncConfig();
    if (!resolution) throw new Error("desktop_sync_not_configured");
    await installService(createStandaloneDaemonServiceCommand());
    await startService();
    process.stdout.write(`${JSON.stringify({ ok: true, profile: resolution.profileName })}\n`);
  } catch (err: unknown) {
    console.error(JSON.stringify({
      ok: false,
      error: err instanceof Error && err.message === "desktop_sync_not_configured"
        ? err.message
        : "desktop_activation_failed",
    }));
    process.exitCode = 1;
  }
} else if (shouldRunDesktopRevocation(rawArgs)) {
  const { loadProfileAuth, clearProfileAuth } = await import("../auth/token-store.js");
  const { revokeSyncDeviceAuth } = await import("../auth/sync-device.js");
  const { loadProfiles } = await import("../lib/profiles.js");
  const { sendCommand } = await import("./daemon-client.js");
  try {
    await sendCommand("sync.pause").catch(() => undefined);
    const profiles = await loadProfiles({ migrateLegacyFiles: false });
    const profile = profiles.profiles.desktop;
    const auth = await loadProfileAuth("desktop");
    if (profile && auth?.refreshToken) {
      await revokeSyncDeviceAuth({ platformUrl: profile.platformUrl, auth });
    }
    if (auth) await clearProfileAuth("desktop");
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  } catch {
    console.error(JSON.stringify({ ok: false, error: "desktop_revocation_failed" }));
    process.exitCode = 1;
  }
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
