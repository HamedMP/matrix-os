import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS = new Set(["start", "send", "status", "doctor", "help", "version"]);

export interface ParsedArgs {
  command: string;
  message?: string;
  gateway: string;
  token?: string;
  shell?: boolean;
  session?: string;
  noStream?: boolean;
}

export interface StatusInfo {
  healthy: boolean;
  error?: string;
  health?: { status: string; cronJobs: number; channels: Record<string, boolean> };
  systemInfo?: {
    version: string;
    uptime: number;
    modules: number;
    channels: Record<string, boolean>;
    skills: number;
    todayCost: number;
  };
  channels?: Record<string, { status: string }>;
  cronJobs?: Array<{ id: string; message: string; schedule: { type: string; expression?: string } }>;
}

export interface DoctorCheck {
  name: string;
  passed: boolean;
  detail: string;
  fix?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: "help",
    gateway: "http://localhost:4000",
  };

  if (argv.length === 0) return result;

  let positionalIndex = 0;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--version") {
      result.command = "version";
      i++;
      continue;
    }

    if (arg === "--help") {
      result.command = "help";
      i++;
      continue;
    }

    if (arg === "--gateway" && i + 1 < argv.length) {
      result.gateway = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--token" && i + 1 < argv.length) {
      result.token = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--shell") {
      result.shell = true;
      i++;
      continue;
    }

    if (arg === "--session" && i + 1 < argv.length) {
      result.session = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === "--no-stream") {
      result.noStream = true;
      i++;
      continue;
    }

    if (positionalIndex === 0) {
      if (COMMANDS.has(arg)) {
        result.command = arg;
      } else {
        result.command = "help";
      }
      positionalIndex++;
    } else if (positionalIndex === 1 && result.command === "send") {
      result.message = arg;
      positionalIndex++;
    }

    i++;
  }

  return result;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatStatus(info: StatusInfo): string {
  const lines: string[] = [];

  if (!info.healthy) {
    lines.push("Gateway: unreachable");
    if (info.error) lines.push(`  Error: ${info.error}`);
    return lines.join("\n");
  }

  lines.push("Gateway: healthy");

  if (info.systemInfo) {
    const si = info.systemInfo;
    lines.push(`  Version:  ${si.version}`);
    lines.push(`  Uptime:   ${formatUptime(si.uptime)}`);
    lines.push(`  Modules:  ${si.modules}`);
    lines.push(`  Skills:   ${si.skills}`);
    lines.push(`  Cost:     $${si.todayCost.toFixed(2)}`);
  }

  if (info.channels) {
    lines.push("");
    lines.push("Channels:");
    for (const [name, ch] of Object.entries(info.channels)) {
      lines.push(`  ${name}: ${ch.status}`);
    }
  }

  if (info.cronJobs && info.cronJobs.length > 0) {
    lines.push("");
    lines.push("Cron Jobs:");
    for (const job of info.cronJobs) {
      const sched = job.schedule.expression ?? job.schedule.type;
      lines.push(`  [${job.id}] ${job.message} (${sched})`);
    }
  }

  return lines.join("\n");
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;

  for (const check of checks) {
    const marker = check.passed ? "PASS" : "FAIL";
    lines.push(`  [${marker}] ${check.name}: ${check.detail}`);
    if (!check.passed && check.fix) {
      lines.push(`         Fix: ${check.fix}`);
    }
  }

  lines.push("");
  lines.push(`${passed} passed, ${failed} failed`);

  if (failed === 0) {
    lines.push("All checks passed");
  }

  return lines.join("\n");
}

export function getVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function getHelpText(): string {
  return `Matrix OS CLI

Usage: matrixos <command> [options]

Commands:
  start       Start the gateway (and optionally the shell)
  send        Send a message to the kernel
  status      Show gateway health and status
  doctor      Run diagnostic checks
  help        Show this help text
  version     Show version

Options:
  --gateway URL    Gateway URL (default: http://localhost:4000)
  --token TOKEN    Auth token for gateway requests

Start options:
  --shell          Also start the Next.js shell

Send options:
  --session ID     Send to a specific session
  --no-stream      Wait for complete response`;
}
