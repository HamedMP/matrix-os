#!/usr/bin/env node

import {
  parseArgs,
  formatStatus,
  formatDoctor,
  getVersion,
  getHelpText,
  buildWorkspaceRequest,
  formatWorkspaceResponse,
} from "./cli.js";
import type { StatusInfo, DoctorCheck, ParsedArgs } from "./cli.js";
import { buildTuiDashboardModel, renderTuiDashboard } from "./tui/dashboard.js";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolvePublishedCliRedirect } from "../packages/cli/src/index.js";

const args = parseArgs(process.argv.slice(2));
const CLI_FETCH_TIMEOUT_MS = 10_000;

// Auto-pick the saved auth token from `matrix login` so commands like
// `matrix status` work without an explicit --token. Explicit --token wins.
if (!args.token) {
  const authPath = join(homedir(), ".matrixos", "auth.json");
  try {
    const raw = JSON.parse(readFileSync(authPath, "utf-8")) as { accessToken?: string };
    if (raw.accessToken) args.token = raw.accessToken;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // No saved auth -- that's fine; commands that need a token will fail clearly.
    } else {
      console.warn(
        "[matrixos] Failed to load saved auth:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

async function fetchJSON(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(CLI_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchWorkspaceJSON(
  gateway: string,
  request: ReturnType<typeof buildWorkspaceRequest>,
  token?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (request.body) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(request.body);
  }
  const res = await fetch(`${gateway}${request.path}`, {
    method: request.method,
    headers,
    body,
    signal: AbortSignal.timeout(CLI_FETCH_TIMEOUT_MS),
  });
  const data = await res.json().catch((err: unknown) => {
    if (err instanceof SyntaxError) {
      return null;
    }
    console.warn("[matrixos] Failed to parse workspace response:", err instanceof Error ? err.message : String(err));
    return null;
  });
  if (!res.ok) {
    const error = typeof data === "object" && data !== null && "error" in data
      ? (data as { error?: { code?: string; message?: string } }).error
      : undefined;
    throw new Error(error?.message ?? `HTTP ${res.status}`);
  }
  return data;
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
      signal: AbortSignal.timeout(CLI_FETCH_TIMEOUT_MS),
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
  } catch (err: unknown) {
    console.error(`Failed to send: ${err instanceof Error ? err.message : String(err)}`);
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
  } catch (err: unknown) {
    info.error = err instanceof Error ? err.message : String(err);
  }

  console.log(formatStatus(info));
  process.exit(info.healthy ? 0 : 1);
}

async function runWorkspaceCommand(args: ParsedArgs) {
  try {
    const request = buildWorkspaceRequest(args);
    const data = await fetchWorkspaceJSON(args.gateway, request, args.token);
    console.log(formatWorkspaceResponse(args.command, args.subcommand, data));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function runTui(args: { gateway: string; token?: string }) {
  const projectsData = await fetchJSON(`${args.gateway}/api/projects`, args.token) as { projects?: Array<{ slug?: string; name?: string }> };
  const projects = projectsData.projects ?? [];
  const firstProjectSlug = projects[0]?.slug;
  const [pullRequestsData, worktreesData, tasksData, sessionsData, reviewsData] = await Promise.all([
    firstProjectSlug
      ? fetchJSON(`${args.gateway}/api/projects/${encodeURIComponent(firstProjectSlug)}/prs`, args.token)
      : Promise.resolve({ prs: [] }),
    firstProjectSlug
      ? fetchJSON(`${args.gateway}/api/projects/${encodeURIComponent(firstProjectSlug)}/worktrees`, args.token)
      : Promise.resolve({ worktrees: [] }),
    firstProjectSlug
      ? fetchJSON(`${args.gateway}/api/projects/${encodeURIComponent(firstProjectSlug)}/tasks?limit=100`, args.token)
      : Promise.resolve({ tasks: [] }),
    fetchJSON(`${args.gateway}/api/sessions?limit=100`, args.token),
    fetchJSON(`${args.gateway}/api/reviews?limit=100`, args.token),
  ]) as [
    { prs?: Array<{ number?: number; title?: string; headRef?: string; state?: string }> },
    { worktrees?: Array<{ id?: string; currentBranch?: string; dirtyState?: string }> },
    { tasks?: Array<{ id?: string; title?: string; status?: string; priority?: string }> },
    { sessions?: Array<{ id?: string; status?: string; projectSlug?: string; taskId?: string; nativeAttachCommand?: string[] }> },
    { reviews?: Array<{ id?: string; status?: string; projectSlug?: string; round?: number }> },
  ];

  const model = buildTuiDashboardModel({
    projects,
    pullRequests: pullRequestsData.prs ?? [],
    worktrees: worktreesData.worktrees ?? [],
    tasks: tasksData.tasks ?? [],
    sessions: sessionsData.sessions ?? [],
    reviews: reviewsData.reviews ?? [],
  });

  if (process.stdout.isTTY && process.stdin.isTTY) {
    const { renderInkDashboard } = await import("./tui/app.js");
    await renderInkDashboard({ model });
    return;
  }

  console.log(renderTuiDashboard(model));
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
  } catch (err: unknown) {
    checks.push({
      name: "pnpm installed",
      passed: false,
      detail: err instanceof Error ? err.message : "Not found",
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
  } catch (err: unknown) {
    checks.push({
      name: "Gateway reachable",
      passed: false,
      detail: err instanceof Error ? err.message : "Not running",
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
  } catch (err: unknown) {
    checks.push({
      name: "Disk space",
      passed: true,
      detail: err instanceof Error ? `Unable to check (${err.message})` : "Unable to check",
    });
  }

  console.log(formatDoctor(checks));
  const failed = checks.filter((c) => !c.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

function runSyncCli(subArgs: string[]): Promise<void> {
  const cliPath = join(import.meta.dirname, "..", "packages", "sync-client", "src", "cli", "index.ts");
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", cliPath, ...subArgs], {
      cwd: join(import.meta.dirname, ".."),
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`Sync CLI exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const publishedRedirect = resolvePublishedCliRedirect(rawArgs);
  if (publishedRedirect) {
    await runSyncCli(publishedRedirect);
    return;
  }

  if (rawArgs.length === 0) {
    await runTui(args);
    return;
  }

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
    case "tui":
      await runTui(args);
      break;
    case "project":
    case "worktree":
    case "workspace":
    case "session":
    case "agent":
    case "review":
    case "task":
    case "preview":
      await runWorkspaceCommand(args);
      break;
    case "sync": {
      const syncArgs = rawArgs.slice(1).filter((a) => !a.startsWith("--gateway") && !a.startsWith("--token"));
      await runSyncCli(["sync", ...syncArgs]);
      break;
    }
    case "login":
      // Forward all extra args (e.g. --dev, --platform <url>) to the sync CLI.
      await runSyncCli(["login", ...rawArgs.slice(1)]);
      break;
    case "logout":
      await runSyncCli(["logout", ...rawArgs.slice(1)]);
      break;
    case "peers":
      await runSyncCli(["peers", ...rawArgs.slice(1)]);
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
