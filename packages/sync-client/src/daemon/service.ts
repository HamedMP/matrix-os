import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { execFile } from "node:child_process";

function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, reject) => {
    execFile(cmd, args, (err) => {
      if (err) reject(err);
      else res();
    });
  });
}

const LABEL = "com.matrixos.sync";

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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

function launchdPlist(daemonPath: string, logDir: string, workDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(daemonPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workDir)}</string>
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

function systemdUnit(daemonPath: string, workDir: string): string {
  return `[Unit]
Description=Matrix OS Sync Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${workDir}
ExecStart=${process.execPath} ${daemonPath}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export async function installService(daemonPath: string): Promise<string> {
  const os = platform();
  const logDir = join(homedir(), ".matrixos", "logs");
  await mkdir(logDir, { recursive: true });
  const workDir = findRepoRoot(resolve(daemonPath));

  if (os === "darwin") {
    const plistDir = join(homedir(), "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    const plistPath = join(plistDir, `${LABEL}.plist`);
    await writeFile(plistPath, launchdPlist(daemonPath, logDir, workDir));
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
    await writeFile(unitPath, systemdUnit(daemonPath, workDir));
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
    await execFileAsync("launchctl", ["unload", plistPath]).catch(() => {});
    await execFileAsync("launchctl", ["load", "-w", plistPath]);
    return;
  }

  if (os === "linux") {
    await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => {});
    await execFileAsync("systemctl", [
      "--user",
      "enable",
      "--now",
      "matrixos-sync.service",
    ]);
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
