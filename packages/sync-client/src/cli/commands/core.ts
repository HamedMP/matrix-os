/**
 * `matrix core sync [--install-timer]` (spec 2691, layer 6): install the
 * pinned Matrix Core repo commit for every org the caller belongs to.
 *
 * On a Matrix VPS it authenticates with the machine credential the host
 * already holds (`MATRIX_HANDLE`, `UPGRADE_TOKEN`, `PLATFORM_INTERNAL_URL`),
 * from the environment or, with `--machine`, read at run time from the
 * protected host env file; elsewhere with the logged-in CLI profile. `--install-timer` adds an hourly
 * systemd user timer (Linux) or launchd agent (macOS) that runs the same sync.
 */
import { execFile } from "node:child_process";
import { access, mkdir, open, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  parseSkillTargets,
  type CoreRepoTransport,
} from "../../core-repo/installer.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SKILL_SYNC_SCRIPT = "/opt/matrix/app/scripts/sync-matrix-agent-skills.sh";
const TIMER_NAME = "matrix-core-sync";
const LAUNCHD_LABEL = "com.matrix-os.core-sync";

export function coreRepoRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.MATRIX_CORE_ROOT ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "matrix-core");
}

/** The VPS host env file (root:matrix 0640) that holds the machine credential. */
export const DEFAULT_MACHINE_ENV_FILE = "/opt/matrix/env/host.env";
const MACHINE_ENV_MAX_BYTES = 64 * 1024;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

function invalidTimer(): Error {
  return Object.assign(new Error("timer_path_invalid"), { code: "timer_path_invalid" });
}

function checked(value: string): string {
  if (!value || value.length > 4_096 || /[\x00-\x1f\x7f]/.test(value)) throw invalidTimer();
  return value;
}

/** One systemd word: quoted, with `\`, `"`, `%` (specifiers), and optionally `$` (expansion) escaped. */
function systemdQuote(value: string, escapeDollar: boolean): string {
  let escaped = checked(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (escapeDollar) escaped = escaped.replace(/\$/g, "$$$$");
  return `"${escaped}"`;
}

function xml(value: string): string {
  return checked(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * The published launcher (`bin/matrix.mjs`), which re-execs Node with the tsx
 * loader. `process.argv[1]` is the TypeScript entry and cannot run alone.
 */
export function resolveCoreSyncLauncher(): string {
  return fileURLToPath(new URL("../../../bin/matrix.mjs", import.meta.url));
}

function machineCredentialUnavailable(): Error {
  return Object.assign(new Error("machine_credential_unavailable"), { code: "machine_credential_unavailable" });
}

/**
 * Reads the machine credential from the host env file at run time, so a
 * scheduled run never needs it copied into a unit. Only the three keys are
 * read; anything missing or unreadable is an error, never a fallback to CLI login.
 */
export async function loadCoreRepoMachineCredential(path: string): Promise<{ handle: string; token: string; platformUrl: string }> {
  let text: string;
  try {
    // Read at most the cap plus one byte so an oversized file is never buffered.
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(MACHINE_ENV_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MACHINE_ENV_MAX_BYTES) throw machineCredentialUnavailable();
      text = buffer.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "machine_credential_unavailable") throw machineCredentialUnavailable();
    throw error;
  }
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(MATRIX_HANDLE|UPGRADE_TOKEN|PLATFORM_INTERNAL_URL)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const raw = match[2]!.trim();
    values.set(match[1]!, /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw);
  }
  const handle = values.get("MATRIX_HANDLE"), token = values.get("UPGRADE_TOKEN"), platformUrl = values.get("PLATFORM_INTERNAL_URL");
  if (!handle || !token || !platformUrl) throw machineCredentialUnavailable();
  return { handle, token, platformUrl };
}

export interface CoreSyncTimerInput {
  platform: NodeJS.Platform;
  home: string;
  node: string;
  launcher: string;
  /** The CLI profile the manual run used; absent for the machine credential. */
  profile?: string;
  /** Re-read the machine credential from the host env file on every run (`--machine`). */
  machine?: boolean;
  /** Non-secret settings only (paths and targets); tokens are never written to a unit. */
  env: Record<string, string>;
}

/** Unit files for an hourly `matrix core sync`. Pure, so the content is testable. */
export function coreSyncTimerFiles(input: CoreSyncTimerInput): Array<{ path: string; content: string }> {
  if (input.profile !== undefined && !PROFILE_NAME.test(input.profile)) throw invalidTimer();
  const env = Object.entries(input.env);
  if (env.some(([key]) => !ENV_KEY.test(key))) throw invalidTimer();
  const args = [input.node, input.launcher, "core", "sync",
    ...(input.machine ? ["--machine"] : input.profile ? ["--profile", input.profile] : [])];
  if (input.platform === "darwin") {
    const environment = env.length === 0 ? "" : `
  <key>EnvironmentVariables</key><dict>${env.map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>`;
    return [{ path: join(input.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`), content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>${environment}
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
${env.map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`, false)}\n`).join("")}ExecStart=${args.map(arg => systemdQuote(arg, true)).join(" ")}
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

async function installTimer(settings: { profile?: string; machine?: boolean; env: Record<string, string> }): Promise<string> {
  const files = coreSyncTimerFiles({ platform: process.platform, home: homedir(), node: process.execPath,
    launcher: resolveCoreSyncLauncher(), ...settings });
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

/** The transport, plus how it authenticated: a CLI profile, or the machine credential. */
async function transportFor(args: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<{ transport: CoreRepoTransport; profile?: string; machine?: boolean }> {
  const machineTransport = (credential: { handle: string; token: string; platformUrl: string }) => createCoreRepoHttpTransport({
    baseUrl: credential.platformUrl, headers: { "x-matrix-handle": credential.handle, authorization: `Bearer ${credential.token}` } });
  if (args.machine === true) {
    return { transport: machineTransport(await loadCoreRepoMachineCredential(env.MATRIX_MACHINE_ENV_FILE ?? DEFAULT_MACHINE_ENV_FILE)), machine: true };
  }
  if (env.MATRIX_HANDLE && env.UPGRADE_TOKEN && env.PLATFORM_INTERNAL_URL) {
    return { transport: machineTransport({ handle: env.MATRIX_HANDLE, token: env.UPGRADE_TOKEN, platformUrl: env.PLATFORM_INTERNAL_URL }), machine: true };
  }
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
  return { transport: createCoreRepoHttpTransport({ baseUrl: profile.platformUrl, headers: { authorization: `Bearer ${token}` } }), profile: profile.name };
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
    machine: { type: "boolean", required: false, default: false, description: "Use this Matrix computer's machine credential (VPS)" },
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
      const { transport, profile, machine } = await transportFor(args, process.env);
      const root = coreRepoRoot();
      const results = await installCoreRepo({ transport, root, runSkillSync: createScriptSkillSync(script),
        targets: parseSkillTargets(process.env.MATRIX_SKILL_TARGETS) });
      // The timer repeats this exact run: same profile, script, root, and targets (never a token).
      // A machine-credential timer re-reads the host env file each run instead of carrying the token.
      const timer = args["install-timer"] === true ? await installTimer({ ...(machine ? { machine } : profile ? { profile } : {}), env: {
        MATRIX_SKILLS_SYNC_SCRIPT: script, MATRIX_CORE_ROOT: root,
        ...(machine && process.env.MATRIX_MACHINE_ENV_FILE ? { MATRIX_MACHINE_ENV_FILE: process.env.MATRIX_MACHINE_ENV_FILE } : {}),
        ...(process.env.MATRIX_SKILL_TARGETS ? { MATRIX_SKILL_TARGETS: process.env.MATRIX_SKILL_TARGETS } : {}),
      } }) : undefined;
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
