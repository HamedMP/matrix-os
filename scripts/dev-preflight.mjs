#!/usr/bin/env node

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parity = resolve(root, ".amp/in/local-production-parity");
const sshKey = resolve(parity, "runtime/operator_ed25519");
const knownHosts = resolve(parity, "runtime/known_hosts");
const MAX_OUTPUT = 1024 * 1024;

const pass = (id, detail) => ({ id, level: "PASS", detail });
const fail = (id, detail) => ({ id, level: "FAIL", detail });
const warn = (id, detail) => ({ id, level: "WARN", detail });
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function evaluateCatalog(value) {
  const instances = Array.isArray(value?.instances) ? value.instances : [];
  const ready = instances.some((instance) => instance?.availability === "available"
    && instance?.supports?.rootChat === true
    && Array.isArray(instance?.supports?.interactionModes)
    && instance.supports.interactionModes.includes("default")
    && Array.isArray(instance?.models)
    && instance.models.some((model) => model?.availability === "available"
      && Array.isArray(model.capabilities)
      && model.capabilities.includes("reasoning")
      && model.capabilities.includes("tools")));
  return ready
    ? pass("provider-catalog", "authenticated catalog has an available reasoning/tools route for Aoede")
    : fail("provider-catalog", "no available authenticated reasoning/tools route supports Aoede root chat");
}

function responseCheck(id, response, detail) {
  if (response?.status === 401 || response?.status === 403) return fail(id, "authentication was not accepted");
  return response?.status >= 200 && response.status < 300 ? pass(id, detail) : fail(id, `HTTP ${response?.status ?? "unavailable"}`);
}

export async function runPreflight(deps) {
  const checks = [];
  const requiredCommands = [
    ["docker", "Docker daemon is reachable"],
    ["platform-container", "local parity platform container is running"],
    ["vm-ssh", "production-parity VM accepts SSH"],
    ["gateway-service", "matrix-gateway systemd service is active"],
    ["shell-service", "matrix-shell systemd service is active"],
    ["terminal-service", "matrix-terminal-runtime systemd service is active"],
    ["gateway-health", "gateway health responds inside the VM"],
    ["shell-proxy", "host shell proxy responds over TLS"],
  ];
  for (const [id, detail] of requiredCommands) {
    try {
      checks.push((await deps.command(id)).ok ? pass(id, detail) : fail(id, `${detail} check failed`));
    } catch (error) {
      checks.push(fail(id, error instanceof Error && error.name === "AbortError" ? "check timed out" : `${detail} check failed`));
    }
  }

  try {
    checks.push(responseCheck("platform-health", await deps.platformHealth(), "platform health endpoint is ready"));
  } catch (error) {
    checks.push(fail("platform-health", error instanceof Error && error.name === "TimeoutError" ? "check timed out" : "platform health request failed"));
  }

  let catalog;
  try {
    catalog = await deps.authenticatedGet("/api/chat-providers");
    checks.push(catalog.status === 200 ? evaluateCatalog(catalog.json) : responseCheck("provider-catalog", catalog, "provider catalog is readable"));
  } catch {
    checks.push(fail("provider-catalog", "authenticated provider catalog request failed"));
  }

  try {
    const capabilities = await deps.authenticatedGet("/api/integrations/capabilities");
    checks.push(responseCheck("capabilities", capabilities, "authenticated capability inventory is readable"));
  } catch {
    checks.push(fail("capabilities", "authenticated capability inventory request failed"));
  }

  try {
    const integrations = await deps.authenticatedGet("/api/integrations");
    if (integrations.status === 503 && integrations.json?.error === "integrations_unavailable") {
      checks.push(warn("integrations", "optional Pipedream integrations are not configured"));
    } else {
      const checked = responseCheck("integrations", integrations, "optional integration catalog is available");
      checks.push(checked.level === "FAIL" ? warn("integrations", checked.detail) : checked);
    }
  } catch {
    checks.push(warn("integrations", "optional integration catalog could not be checked"));
  }

  checks.push(catalog?.status === 200 && evaluateCatalog(catalog.json).level === "PASS"
    ? pass("aoede", "Aoede prerequisites are verified without bootstrapping or mutating a conversation")
    : fail("aoede", "Aoede prerequisites are not verified"));
  checks.push(warn("paid-voice-e2e", "not run: preflight makes no provider calls and does not verify real paid voice E2E"));
  return { checks, exitCode: checks.some((check) => check.level === "FAIL") ? 1 : 0 };
}

function sshArgs(command) {
  return ["-i", sshKey, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=5",
    "-p", "2222", "-o", "StrictHostKeyChecking=no", "-o", `UserKnownHostsFile=${knownHosts}`,
    "matrix-local-operator@127.0.0.1", ...command];
}

async function execute(command, args, expectedOutput) {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd: root, timeout: 10_000, maxBuffer: MAX_OUTPUT });
    return { ok: expectedOutput === undefined || stdout.trim() === expectedOutput };
  } catch {
    return { ok: false };
  }
}

async function commandCheck(id) {
  const commands = {
    docker: ["docker", ["info"]],
    "platform-container": ["docker", ["container", "inspect", "--format", "{{.State.Running}}", "matrix-os-parity-platform"], "true"],
    "vm-ssh": ["ssh", sshArgs(["true"])],
    "gateway-service": ["ssh", sshArgs(["sudo", "systemctl", "is-active", "--quiet", "matrix-gateway.service"])],
    "shell-service": ["ssh", sshArgs(["sudo", "systemctl", "is-active", "--quiet", "matrix-shell.service"])],
    "terminal-service": ["ssh", sshArgs(["sudo", "systemctl", "is-active", "--quiet", "matrix-terminal-runtime.service"])],
    "gateway-health": ["ssh", sshArgs(["curl", "--fail", "--silent", "--max-time", "5", "http://127.0.0.1:4000/health"])],
    "shell-proxy": ["curl", ["--insecure", "--fail", "--silent", "--max-time", "5", "https://127.0.0.1:8443/health"]],
  };
  const selected = commands[id];
  return selected ? execute(selected[0], selected[1], selected[2]) : { ok: false };
}

async function getJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5_000) });
  const text = (await response.text()).slice(0, MAX_OUTPUT);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return { status: response.status, json };
}

async function authenticatedGet(path) {
  const script = `set -a; . /opt/matrix/env/host.env; set +a; curl --silent --show-error --max-time 15 --max-filesize ${MAX_OUTPUT} --write-out '\n%{http_code}' -H 'Authorization: Bearer '"$MATRIX_AUTH_TOKEN" http://127.0.0.1:4000${path}`;
  const remote = [`sudo sh -c ${shellQuote(script)}`];
  try {
    const { stdout } = await execFileAsync("ssh", sshArgs(remote), { cwd: root, timeout: 20_000, maxBuffer: MAX_OUTPUT });
    const marker = stdout.lastIndexOf("\n");
    const body = marker >= 0 ? stdout.slice(0, marker) : "";
    const status = marker >= 0 ? Number(stdout.slice(marker + 1).trim()) : 0;
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    return { status, json };
  } catch {
    return { status: 0, json: null };
  }
}

async function main() {
  const result = await runPreflight({
    command: commandCheck,
    platformHealth: () => getJson(`http://127.0.0.1:${process.env.MATRIX_PARITY_PLATFORM_PORT ?? "9003"}/health`),
    authenticatedGet,
  });
  for (const check of result.checks) console.log(`${check.level.padEnd(4)} ${check.id}: ${check.detail}`);
  console.log(result.exitCode === 0 ? "READY local demo prerequisites verified" : "NOT READY required local demo prerequisites failed");
  process.exitCode = result.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => {
  console.error("NOT READY preflight failed safely");
  process.exitCode = 1;
});
