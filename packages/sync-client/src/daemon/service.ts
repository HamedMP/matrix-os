import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { exec } from "node:child_process";

const LABEL = "com.matrixos.sync";

function launchdPlist(daemonPath: string, logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${daemonPath}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/daemon-stderr.log</string>
</dict>
</plist>`;
}

function systemdUnit(daemonPath: string): string {
  return `[Unit]
Description=Matrix OS Sync Daemon
After=network.target

[Service]
Type=simple
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

  if (os === "darwin") {
    const plistDir = join(homedir(), "Library", "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    const plistPath = join(plistDir, `${LABEL}.plist`);
    await writeFile(plistPath, launchdPlist(daemonPath, logDir));
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
    await writeFile(unitPath, systemdUnit(daemonPath));
    return unitPath;
  }

  throw new Error(`Unsupported platform: ${os}`);
}

export function startService(): Promise<void> {
  const os = platform();

  return new Promise((resolve, reject) => {
    const cmd =
      os === "darwin"
        ? `launchctl load -w ~/Library/LaunchAgents/${LABEL}.plist`
        : `systemctl --user enable --now matrixos-sync.service`;

    exec(cmd, (err) => {
      if (err) reject(new Error(`Failed to start service: ${err.message}`));
      else resolve();
    });
  });
}

export function stopService(): Promise<void> {
  const os = platform();

  return new Promise((resolve, reject) => {
    const cmd =
      os === "darwin"
        ? `launchctl unload ~/Library/LaunchAgents/${LABEL}.plist`
        : `systemctl --user stop matrixos-sync.service`;

    exec(cmd, (err) => {
      if (err) reject(new Error(`Failed to stop service: ${err.message}`));
      else resolve();
    });
  });
}
