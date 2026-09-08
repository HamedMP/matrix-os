#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, readdir, readlink, rm } from "node:fs/promises";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";

const PROBE_VERSION = 1;
const MAX_ENVIRONMENT_KEYS = 32;
const MAX_VISIBLE_PROCESSES = 16;
const MAX_OPEN_DESCRIPTORS = 128;
const IO_TIMEOUT_MS = 1_500;
const SCOPE_ROOT = "/workspace";
const BROKER_SOCKET = "/run/matrix-scope/broker.sock";
const SUPERVISOR_SOCKET = "/run/matrix-scope-runtime/supervisor.sock";
const FORBIDDEN_PATHS = [
  "/home/matrix/home",
  "/root",
  "/run/postgresql",
  "/run/containerd/containerd.sock",
  "/var/run/docker.sock",
  "/run/systemd/private",
] as const;
const FORBIDDEN_ENVIRONMENT_KEYS = [
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "CLERK_SECRET_KEY",
  "DATABASE_URL",
  "MATRIX_AUTH_TOKEN",
  "MATRIX_SCOPE_PROBE_OWNER_SECRET",
  "OPENAI_API_KEY",
  "PLATFORM_DATABASE_URL",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

type ProbeReport = {
  version: typeof PROBE_VERSION;
  probe: "matrix-scope-runtime";
  isolated: boolean;
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    architecture: string;
    uid: number | null;
  };
  checks: Check[];
};

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "non_error";
  if ("code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)) {
    return error.code.toLowerCase();
  }
  return error.name.replaceAll(/[^A-Za-z0-9]/g, "_").slice(0, 32).toLowerCase();
}

async function pathIsUnavailable(path: string): Promise<Check> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    await handle.close();
    return check(`filesystem:${path}`, false, "readable");
  } catch (error: unknown) {
    const code = errorCode(error);
    const unavailable = ["eacces", "enodev", "enoent", "enotdir", "enxio", "eperm"].includes(code);
    return check(`filesystem:${path}`, unavailable, code);
  }
}

async function writableScopeRoot(): Promise<Check> {
  const path = `${SCOPE_ROOT}/.matrix-scope-probe-${randomUUID()}`;
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile("scope-only\n", "utf8");
    await handle.close();
    await rm(path);
    return check("filesystem:scope-root", true, "writable");
  } catch (error: unknown) {
    await rm(path, { force: true }).catch((cleanupError: unknown) => {
      process.stderr.write(`scope_probe_cleanup_failed:${errorCode(cleanupError)}\n`);
    });
    return check("filesystem:scope-root", false, errorCode(error));
  }
}

function environmentIsolation(): Check {
  const keys = Object.keys(process.env).sort();
  const exposed = FORBIDDEN_ENVIRONMENT_KEYS.filter((key) => process.env[key] !== undefined);
  const passed = exposed.length === 0 && keys.length <= MAX_ENVIRONMENT_KEYS;
  return check(
    "environment:allowlist",
    passed,
    exposed.length > 0 ? `forbidden_keys:${exposed.join(",")}` : `key_count:${keys.length}`,
  );
}

async function processIsolation(): Promise<Check> {
  try {
    const entries = (await readdir("/proc", { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name))
      .slice(0, MAX_VISIBLE_PROCESSES + 1);
    const ownUid = process.getuid?.();
    if (ownUid === undefined || ownUid === 0 || entries.length > MAX_VISIBLE_PROCESSES) {
      return check("process:namespace", false, `uid:${ownUid ?? "unknown"};count:${entries.length}`);
    }
    for (const entry of entries) {
      const status = await readFile(`/proc/${entry.name}/status`, "utf8");
      const uid = /^Uid:\s+([0-9]+)/m.exec(status)?.[1];
      if (uid !== String(ownUid)) {
        return check("process:namespace", false, "foreign_uid_visible");
      }
    }
    return check("process:namespace", true, `non_root_count:${entries.length}`);
  } catch (error: unknown) {
    return check("process:namespace", false, errorCode(error));
  }
}

async function descriptorIsolation(): Promise<Check> {
  try {
    const descriptors = (await readdir("/proc/self/fd")).filter((entry) => /^[0-9]+$/.test(entry));
    if (descriptors.length > MAX_OPEN_DESCRIPTORS) {
      return check("descriptor:inheritance", false, `count:${descriptors.length}`);
    }
    for (const descriptor of descriptors) {
      let target: string;
      try {
        target = await readlink(`/proc/self/fd/${descriptor}`);
      } catch (error: unknown) {
        if (errorCode(error) === "enoent") continue;
        throw error;
      }
      if (FORBIDDEN_PATHS.some((path) => target === path || target.startsWith(`${path}/`))) {
        return check("descriptor:inheritance", false, "forbidden_target");
      }
    }
    return check("descriptor:inheritance", true, `count:${descriptors.length}`);
  } catch (error: unknown) {
    return check("descriptor:inheritance", false, errorCode(error));
  }
}

async function socketConnects(options: { path: string } | { host: string; port: number }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect(options);
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(IO_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function directNetworkIsolation(): Promise<Check[]> {
  const targets = [
    { name: "loopback", host: "127.0.0.1", port: 4000 },
    { name: "metadata", host: "169.254.169.254", port: 80 },
    { name: "private", host: "10.0.0.1", port: 443 },
    { name: "public", host: "1.1.1.1", port: 443 },
  ] as const;
  return Promise.all(targets.map(async (target) => {
    const connected = await socketConnects({ host: target.host, port: target.port });
    return check(`network:${target.name}`, !connected, connected ? "connected" : "denied");
  }));
}

async function dnsIsolation(): Promise<Check> {
  try {
    await lookup("example.com", { family: 4 });
    return check("network:dns", false, "resolved");
  } catch (error: unknown) {
    return check("network:dns", true, errorCode(error));
  }
}

async function brokerReachability(): Promise<Check> {
  const reachable = await socketConnects({ path: BROKER_SOCKET });
  return check("broker:socket", reachable, reachable ? "reachable" : "unavailable");
}

async function supervisorIsolation(): Promise<Check> {
  const reachable = await socketConnects({ path: SUPERVISOR_SOCKET });
  return check("supervisor:injection", !reachable, reachable ? "reachable" : "denied");
}

async function childBoundary(): Promise<Check> {
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "--child"], {
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length <= 64 * 1024) stdout += chunk;
    });
    child.once("close", (code) => resolve({ code, stdout }));
    child.once("error", () => resolve({ code: null, stdout: "" }));
  });
  try {
    const report = JSON.parse(result.stdout) as ProbeReport;
    return check(
      "child:boundary-inheritance",
      result.code === 0 && report.isolated === true,
      result.code === 0 ? "isolated" : "failed",
    );
  } catch (error: unknown) {
    return check("child:boundary-inheritance", false, errorCode(error));
  }
}

async function run(includeChild: boolean): Promise<ProbeReport> {
  const checks = await Promise.all(FORBIDDEN_PATHS.map(pathIsUnavailable));
  checks.push(await writableScopeRoot());
  checks.push(environmentIsolation());
  checks.push(await processIsolation());
  checks.push(await descriptorIsolation());
  checks.push(...await directNetworkIsolation());
  checks.push(await dnsIsolation());
  checks.push(await brokerReachability());
  checks.push(await supervisorIsolation());
  if (includeChild) checks.push(await childBoundary());
  return {
    version: PROBE_VERSION,
    probe: "matrix-scope-runtime",
    isolated: checks.every((entry) => entry.passed),
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      uid: process.getuid?.() ?? null,
    },
    checks,
  };
}

if (process.env.MATRIX_SCOPE_PROBE_DISPOSABLE !== "1") {
  process.stderr.write("scope_runtime_probe_requires_disposable_host\n");
  process.exit(2);
}

const report = await run(process.argv[2] !== "--child");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.isolated ? 0 : 1);
