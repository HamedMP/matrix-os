/**
 * `matrix core sync [--install-timer]` (spec 2691, layer 6): install the
 * pinned Matrix Core repo commit for every org the caller belongs to.
 *
 * On a Matrix VPS it authenticates with the machine credential the host
 * already holds (`MATRIX_HANDLE`, `UPGRADE_TOKEN`, `PLATFORM_INTERNAL_URL`);
 * elsewhere with the logged-in CLI profile. `--install-timer` adds an hourly
 * systemd user timer (Linux) or launchd agent (macOS) that runs the same sync.
 */
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineCommand } from "citty";
import { requireCliAuthToken } from "../auth-state.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import {
  CoreRepoInstallError,
  createCoreRepoHttpTransport,
  createScriptSkillSync,
  installCoreRepo,
  type CoreRepoTransport,
} from "../../core-repo/installer.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SKILL_SYNC_SCRIPT = "/opt/matrix/app/scripts/sync-matrix-agent-skills.sh";
const TIMER_NAME = "matrix-core-sync";
const LAUNCHD_LABEL = "com.matrix-os.core-sync";

export function coreRepoRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.MATRIX_CORE_ROOT ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "matrix-core");
}

function quote(value: string): string {
  if (/[\x00-\x1f"\\]/.test(value)) throw Object.assign(new Error("timer_path_invalid"), { code: "timer_path_invalid" });
  return `"${value}"`;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Unit files for an hourly run of `<node> <cli> core sync`. Pure, so the content is testable. */
export function coreSyncTimerFiles(input: { platform: NodeJS.Platform; home: string; node: string; cli: string }): Array<{ path: string; content: string }> {
  if (input.platform === "darwin") {
    return [{ path: join(input.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`), content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(input.node)}</string><string>${xml(input.cli)}</string><string>core</string><string>sync</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
` }];
  }
  const dir = join(input.home, ".config", "systemd", "user");
  return [
    { path: join(dir, `${TIMER_NAME}.service`), content: `[Unit]
Description=Matrix Core repo sync

[Service]
Type=oneshot
ExecStart=${quote(input.node)} ${quote(input.cli)} core sync
TimeoutStartSec=600
` },
    { path: join(dir, `${TIMER_NAME}.timer`), content: `[Unit]
Description=Hourly Matrix Core repo sync

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
` },
  ];
}

async function installTimer(): Promise<string> {
  const cli = process.argv[1];
  if (!cli) throw Object.assign(new Error("timer_path_invalid"), { code: "timer_path_invalid" });
  const files = coreSyncTimerFiles({ platform: process.platform, home: homedir(), node: process.execPath, cli });
  for (const file of files) {
    await mkdir(join(file.path, ".."), { recursive: true });
    await writeFile(file.path, file.content, { mode: 0o644 });
  }
  const options = { timeout: 30_000 };
  if (process.platform === "darwin") {
    const uid = String(process.getuid?.() ?? "");
    await execFileAsync("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], options).catch((error: unknown) => {
      // Not loaded yet is the normal first-install case.
      if (!(error instanceof Error)) throw error;
    });
    await execFileAsync("launchctl", ["bootstrap", `gui/${uid}`, files[0]!.path], options);
  } else {
    await execFileAsync("systemctl", ["--user", "daemon-reload"], options);
    await execFileAsync("systemctl", ["--user", "enable", "--now", `${TIMER_NAME}.timer`], options);
  }
  return files.map(file => file.path).join(", ");
}

async function transportFor(args: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<CoreRepoTransport> {
  if (env.MATRIX_HANDLE && env.UPGRADE_TOKEN && env.PLATFORM_INTERNAL_URL) {
    return createCoreRepoHttpTransport({ baseUrl: env.PLATFORM_INTERNAL_URL,
      headers: { "x-matrix-handle": env.MATRIX_HANDLE, authorization: `Bearer ${env.UPGRADE_TOKEN}` } });
  }
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
  return createCoreRepoHttpTransport({ baseUrl: profile.platformUrl, headers: { authorization: `Bearer ${token}` } });
}

function errorCode(error: unknown): string {
  if (error instanceof CoreRepoInstallError) return error.code;
  return error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code : "core_sync_failed";
}

const syncCommand = defineCommand({
  meta: { name: "sync", description: "Install your organizations' pinned Matrix Core repo skills" },
  args: {
    "install-timer": { type: "boolean", required: false, default: false, description: "Also run this sync hourly" },
    profile: { type: "string", required: false },
    dev: { type: "boolean", required: false, default: false },
    json: { type: "boolean", required: false, default: false },
  },
  run: async ({ args }) => {
    const json = args.json === true;
    try {
      const script = process.env.MATRIX_SKILLS_SYNC_SCRIPT ?? DEFAULT_SKILL_SYNC_SCRIPT;
      try { await access(script); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw Object.assign(new Error("skill_sync_unavailable"), { code: "skill_sync_unavailable" });
      }
      const results = await installCoreRepo({
        transport: await transportFor(args, process.env),
        root: coreRepoRoot(),
        runSkillSync: createScriptSkillSync(script),
      });
      const timer = args["install-timer"] === true ? await installTimer() : undefined;
      if (json) console.log(formatCliSuccess({ results, ...(timer ? { timer } : {}) }));
      else {
        if (results.length === 0) console.log("No organization publishes a Matrix Core repo for you yet.");
        for (const result of results) {
          console.log(`${result.orgId}: ${result.status}${result.commit ? ` (${result.commit.slice(0, 12)})` : ""}`);
          if (result.rejectedSkills) console.log(`  skills not installed (invalid, duplicate, or name too long): ${result.rejectedSkills.join(", ")}`);
        }
        if (timer) console.log(`Hourly sync installed: ${timer}`);
      }
      if (results.some(result => result.status === "failed")) process.exitCode = 1;
    } catch (error: unknown) {
      const code = errorCode(error);
      console.error(json ? formatCliError(code) : `Error: Matrix Core sync failed (${code})`);
      process.exitCode = 1;
    }
  },
});

export const coreCommand = defineCommand({
  meta: { name: "core", description: "Matrix Core repo: org-wide skills, hooks, and scripts" },
  subCommands: { sync: syncCommand },
});
