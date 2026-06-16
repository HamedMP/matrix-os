import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { execFile } from "node:child_process";
import { writeUtf8FileAtomic } from "../lib/atomic-write.js";

function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, reject) => {
    execFile(cmd, args, (err) => {
      if (err) reject(err);
      else res();
    });
  });
}

const LABEL = "com.matrixos.sync";

export interface DaemonServiceCommand {
  executable: string;
  args: string[];
  workingDirectory: string;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function escapeSystemdExecArg(value: string): string {
  if (/^[^\s"'\\%$]+$/.test(value)) return value;
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$")
  }"`;
}

export function escapeSystemdUnitValue(value: string): string {
  return Array.from(value, (char) => {
    if (char === "%") return "%%";
    if (/^[A-Za-z0-9/:_.-]$/.test(char)) return char;
    const hex = char.codePointAt(0)?.toString(16).padStart(2, "0");
    return hex === undefined ? "" : `\\x${hex}`;
  }).join("");
}

// Walk up from `daemonPath` to find the directory containing node_modules/tsx.
// launchd/systemd give the spawned process an empty cwd, so node module
// resolution can't find tsx unless we set WorkingDirectory there.
function findRepoRoot(start: string): string {
  let dir = dirname(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "node_modules", "tsx"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dirname(start);
}

export function createSourceDaemonServiceCommand(daemonPath: string): DaemonServiceCommand {
  const resolvedDaemonPath = resolve(daemonPath);
  return {
    executable: process.execPath,
    args: [resolvedDaemonPath],
    workingDirectory: findRepoRoot(resolvedDaemonPath),
  };
}

export function createStandaloneDaemonServiceCommand(
  executable = process.execPath,
  workingDirectory = homedir(),
): DaemonServiceCommand {
  return {
    executable,
    args: ["__daemon"],
    workingDirectory,
  };
}

export function launchdPlist(command: DaemonServiceCommand, logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(command.executable)}</string>
${command.args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(command.workingDirectory)}</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(`${logDir}/daemon-stdout.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(`${logDir}/daemon-stderr.log`)}</string>
</dict>
</plist>`;
}

export function systemdUnit(command: DaemonServiceCommand): string {
  return `[Unit]
Description=Matrix OS Sync Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${escapeSystemdUnitValue(command.workingDirectory)}
ExecStart=${[command.executable, ...command.args].map(escapeSystemdExecArg).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function linuxStartServiceCommands(): string[][] {
  return [
    ["--user", "daemon-reload"],
    ["--user", "enable", "matrixos-sync.service"],
    ["--user", "restart", "matrixos-sync.service"],
  ];
}

export async function installService(command: DaemonServiceCommand): Promise<string> {
  const os = platform();
  const logDir = join(homedir(), ".matrixos", "logs");
  await mkdir(logDir, { recursive: true });

  if (os === "darwin") {
    const plistDir = join(homedir(), "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    const plistPath = join(plistDir, `${LABEL}.plist`);
    await writeUtf8FileAtomic(plistPath, launchdPlist(command, logDir));
    return plistPath;
  }

  if (os === "linux") {
    const unitDir = join(
      homedir(),
      ".config",
      "systemd",
      "user",
    );
    await mkdir(unitDir, { recursive: true });
    const unitPath = join(unitDir, "matrixos-sync.service");
    await writeUtf8FileAtomic(unitPath, systemdUnit(command));
    return unitPath;
  }

  throw new Error(`Unsupported platform: ${os}`);
}

export async function startService(): Promise<void> {
  const os = platform();
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

  if (os === "darwin") {
    // Unload first so an updated plist actually takes effect; ignore failure
    // since the agent may not be loaded yet.
    await execFileAsync("launchctl", ["unload", plistPath]).catch((err: unknown) => {
      console.warn(
        "[sync/service] launchctl unload failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
    await execFileAsync("launchctl", ["load", "-w", plistPath]);
    return;
  }

  if (os === "linux") {
    const [daemonReload, enable, restart] = linuxStartServiceCommands();
    await execFileAsync("systemctl", daemonReload).catch((err: unknown) => {
      console.warn(
        "[sync/service] systemctl daemon-reload failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
    await execFileAsync("systemctl", enable);
    await execFileAsync("systemctl", restart);
    return;
  }

  throw new Error(`Unsupported platform: ${os}`);
}

export async function stopService(): Promise<void> {
  const os = platform();
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

  if (os === "darwin") {
    await execFileAsync("launchctl", ["unload", plistPath]);
    return;
  }

  if (os === "linux") {
    await execFileAsync("systemctl", ["--user", "stop", "matrixos-sync.service"]);
    return;
  }

  throw new Error(`Unsupported platform: ${os}`);
}
