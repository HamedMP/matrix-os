#!/usr/bin/env node

import { parseArgs, formatStatus, formatDoctor, getVersion, getHelpText } from "./cli.js";
import type { StatusInfo, DoctorCheck } from "./cli.js";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = parseArgs(process.argv.slice(2));

async function fetchJSON(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function runStart(args: { gateway: string; shell?: boolean; token?: string }) {
  const rootDir = join(import.meta.dirname, "..");
  const children: ReturnType<typeof spawn>[] = [];

  const gateway = spawn("node", ["--import", "tsx", "packages/gateway/src/main.ts"], {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env },
  });
  children.push(gateway);

  if (args.shell) {
    const shell = spawn("npx", ["next", "dev"], {
      cwd: join(rootDir, "shell"),
      stdio: "inherit",
      env: { ...process.env },
    });
    children.push(shell);
    console.log("Starting shell at http://localhost:3000");
  }

  console.log("Starting gateway at http://localhost:4000");

  const shutdown = () => {
    for (const child of children) {
      child.kill("SIGTERM");
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve) => {
    gateway.on("exit", () => {
      shutdown();
      resolve();
    });
  });
}

async function runSend(args: { gateway: string; message?: string; token?: string; session?: string; noStream?: boolean }) {
  if (!args.message) {
    console.error("Usage: matrixos send <message>");
    process.exit(1);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (args.token) headers["Authorization"] = `Bearer ${args.token}`;

  try {
    const body: Record<string, string> = { text: args.message };
    if (args.session) body.sessionId = args.session;

    const res = await fetch(`${args.gateway}/api/message`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`Error: HTTP ${res.status}`);
      process.exit(1);
    }

    const data = await res.json() as { events: Array<{ type: string; text?: string; message?: string }> };

    for (const event of data.events) {
      if (event.type === "text" && event.text) {
        process.stdout.write(event.text);
      } else if (event.type === "error" && event.message) {
        console.error(`Error: ${event.message}`);
        process.exit(1);
      }
    }
    console.log();
  } catch (err) {
    console.error(`Failed to send: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function runStatus(args: { gateway: string; token?: string }) {
  const info: StatusInfo = { healthy: false };

  try {
    info.health = await fetchJSON(`${args.gateway}/health`, args.token) as StatusInfo["health"];
    info.systemInfo = await fetchJSON(`${args.gateway}/api/system/info`, args.token) as StatusInfo["systemInfo"];
    info.channels = await fetchJSON(`${args.gateway}/api/channels/status`, args.token) as StatusInfo["channels"];
    info.cronJobs = await fetchJSON(`${args.gateway}/api/cron`, args.token) as StatusInfo["cronJobs"];
    info.healthy = true;
  } catch (err) {
    info.error = (err as Error).message;
  }

  console.log(formatStatus(info));
  process.exit(info.healthy ? 0 : 1);
}

async function runDoctor(args: { gateway: string; token?: string }) {
  const checks: DoctorCheck[] = [];

  // Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1), 10);
  checks.push({
    name: "Node.js version",
    passed: major >= 24,
    detail: nodeVersion,
    fix: major < 24 ? "Install Node.js 24+ from https://nodejs.org" : undefined,
  });

  // pnpm installed
  try {
    const pnpmVersion = execFileSync("pnpm", ["--version"], { encoding: "utf-8" }).trim();
    checks.push({ name: "pnpm installed", passed: true, detail: pnpmVersion });
  } catch {
    checks.push({
      name: "pnpm installed",
      passed: false,
      detail: "Not found",
      fix: "corepack enable && corepack prepare pnpm@latest --activate",
    });
  }

  // ANTHROPIC_API_KEY
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  checks.push({
    name: "ANTHROPIC_API_KEY",
    passed: hasKey,
    detail: hasKey ? "Set" : "Not set",
    fix: hasKey ? undefined : "export ANTHROPIC_API_KEY=sk-ant-...",
  });

  // Gateway reachable
  try {
    await fetchJSON(`${args.gateway}/health`, args.token);
    checks.push({ name: "Gateway reachable", passed: true, detail: args.gateway });
  } catch {
    checks.push({
      name: "Gateway reachable",
      passed: false,
      detail: "Not running",
      fix: "matrixos start",
    });
  }

  // Home directory
  const matrixHome = process.env.MATRIX_HOME ?? join(homedir(), "matrixos");
  const homeExists = existsSync(matrixHome);
  checks.push({
    name: "Home directory",
    passed: homeExists,
    detail: homeExists ? matrixHome : "Not found",
    fix: homeExists ? undefined : "Run 'matrixos start' to initialize the home directory",
  });

  // Disk space
  try {
    const df = execFileSync("df", ["-h", "."], { encoding: "utf-8" });
    const lastLine = df.trim().split("\n").pop() ?? "";
    const parts = lastLine.split(/\s+/);
    const available = parts[3] ?? "unknown";
    checks.push({ name: "Disk space", passed: true, detail: `${available} available` });
  } catch {
    checks.push({ name: "Disk space", passed: true, detail: "Unable to check" });
  }

  console.log(formatDoctor(checks));
  const failed = checks.filter((c) => !c.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

async function main() {
  switch (args.command) {
    case "start":
      await runStart(args);
      break;
    case "send":
      await runSend(args);
      break;
    case "status":
      await runStatus(args);
      break;
    case "doctor":
      await runDoctor(args);
      break;
    case "version":
      console.log(`matrixos ${getVersion()}`);
      break;
    case "help":
    default:
      console.log(getHelpText());
      break;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
