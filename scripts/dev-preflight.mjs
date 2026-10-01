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
const parityCertificate = resolve(parity, "storage-tls/certificate.pem");
const MAX_OUTPUT = 1024 * 1024;

const pass = (id, detail) => ({ id, level: "PASS", detail });
const fail = (id, detail) => ({ id, level: "FAIL", detail });
const warn = (id, detail) => ({ id, level: "WARN", detail });
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function evaluateCatalog(value) {
  const instances = Array.isArray(value?.instances) ? value.instances : [];
  const routes = instances.filter((instance) => instance?.driverKind === "codex"
    && instance?.availability === "available"
    && instance?.supports?.rootChat === true
    && Array.isArray(instance?.supports?.interactionModes)
    && instance.supports.interactionModes.includes("default")
    && Array.isArray(instance?.models)
    && instance.models.some((model) => model?.availability === "available"
      && Array.isArray(model.capabilities)
      && model.capabilities.includes("reasoning")
      && model.capabilities.includes("tools")))
    .filter((instance) => typeof instance.id === "string")
    .map((instance) => ({
      instanceId: instance.id,
      modelIds: instance.models.filter((model) => model?.availability === "available"
        && Array.isArray(model.capabilities)
        && model.capabilities.includes("reasoning")
        && model.capabilities.includes("tools"))
        .map((model) => model.id).filter((id) => typeof id === "string"),
    }));
  const instanceIds = routes.map((route) => route.instanceId);
  return {
    instanceIds, routes,
    check: instanceIds.length > 0
      ? pass("provider-catalog", "authenticated catalog has an available canonical Codex route")
      : fail("provider-catalog", "no available authenticated canonical Codex route supports Aoede"),
  };
}

function safeFailure(error, fallback) {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "check timed out";
  return fallback;
}

function evaluateVoice(response) {
  const responseResult = responseCheck("voice-capabilities", response, "existing Codex Chat has readable voice capabilities");
  if (responseResult.level === "FAIL") return responseResult;
  const capability = response.json;
  return capability?.status === "available"
    && capability?.actionMode === "canonical_actions"
    && Array.isArray(capability?.transportModes) && capability.transportModes.includes("relayed_websocket")
    && Array.isArray(capability?.turnModes) && capability.turnModes.includes("hands_free")
    ? pass("voice-capabilities", "speech and canonical Codex actions are available over hands-free relayed WebSocket")
    : fail("voice-capabilities", "voice readiness must be available with canonical_actions, relayed_websocket, and hands_free");
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
    ["storage-tls", "storage dependency responds through verified TLS"],
    ["speech-tls", "managed speech metadata endpoint responds through verified TLS"],
    ["shell-proxy", "host shell proxy routes the application HTML over TLS"],
  ];
  for (const [id, detail] of requiredCommands) {
    try {
      checks.push((await deps.command(id)).ok ? pass(id, detail) : fail(id, `${detail} check failed`));
    } catch (error) {
      checks.push(fail(id, safeFailure(error, `${detail} check failed`)));
    }
  }

  try {
    checks.push(responseCheck("platform-health", await deps.platformHealth(), "platform health endpoint is ready"));
  } catch (error) {
    checks.push(fail("platform-health", safeFailure(error, "platform health request failed")));
  }

  let catalog;
  let codexRoutes = [];
  try {
    catalog = await deps.authenticatedGet("/api/chat-providers");
    const evaluated = evaluateCatalog(catalog.json);
    codexRoutes = catalog.status === 200 ? evaluated.routes : [];
    checks.push(catalog.status === 200 ? evaluated.check : responseCheck("provider-catalog", catalog, "provider catalog is readable"));
  } catch (error) {
    checks.push(fail("provider-catalog", safeFailure(error, "authenticated provider catalog request failed")));
  }

  let voiceReady = false;
  let matchingChat = null;
  if (codexRoutes.length > 0) {
    try {
      const chats = await deps.authenticatedGet("/api/chats?limit=100");
      if (chats.status !== 200) {
        checks.push(responseCheck("existing-chat", chats, "existing Chats are readable"));
      } else {
        const items = Array.isArray(chats.json?.items) ? chats.json.items : [];
        matchingChat = items.find((item) => {
          const selection = item?.chat?.currentSelection;
          const binding = item?.providerBinding;
          const requestedId = deps.chatId;
          const route = codexRoutes.find((candidate) => candidate.instanceId === selection?.instanceId);
          return (!requestedId || item?.chat?.id === requestedId)
            && route?.modelIds.includes(selection?.model)
            && (!binding || (binding.driverKind === "codex" && binding.instanceId === selection.instanceId));
        }) ?? null;
        checks.push(matchingChat
          ? pass("existing-chat", `existing Chat ${matchingChat.chat.id} uses an available canonical Codex route`)
          : fail("existing-chat", "no existing Chat uses an available canonical Codex route"));
      }
    } catch (error) {
      checks.push(fail("existing-chat", safeFailure(error, "authenticated Chat list request failed")));
    }
  }
  if (matchingChat) {
    try {
      const capability = await deps.authenticatedGet(`/api/chats/${encodeURIComponent(matchingChat.chat.id)}/voice/capabilities?surface=web_desktop`);
      const evaluated = evaluateVoice(capability);
      voiceReady = evaluated.level === "PASS";
      checks.push(evaluated);
    } catch (error) {
      checks.push(fail("voice-capabilities", safeFailure(error, "voice capability request failed")));
    }
  }

  try {
    const capabilities = await deps.authenticatedGet("/api/integrations/capabilities");
    checks.push(responseCheck("capabilities", capabilities, "authenticated capability inventory is readable"));
  } catch (error) {
    checks.push(fail("capabilities", safeFailure(error, "authenticated capability inventory request failed")));
  }

  try {
    const integrations = await deps.authenticatedGet("/api/integrations");
    if (integrations.status === 503 && integrations.json?.error === "integrations_unavailable") {
      checks.push(warn("integrations", "optional Pipedream integrations are not configured"));
    } else {
      const checked = responseCheck("integrations", integrations, "optional integration catalog is available");
      checks.push(checked.level === "FAIL" ? warn("integrations", checked.detail) : checked);
    }
  } catch (error) {
    checks.push(warn("integrations", safeFailure(error, "optional integration catalog could not be checked")));
  }

  checks.push(catalog?.status === 200 && matchingChat && voiceReady
    ? pass("aoede", "existing Codex Chat, canonical actions, and managed speech are ready without mutation")
    : fail("aoede", "Aoede is not ready. Open Aoede once with a Codex Chat, then retry this read-only preflight."));
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
    const output = stdout.trim();
    return { ok: expectedOutput === undefined || (typeof expectedOutput === "function" ? expectedOutput(output) : output === expectedOutput) };
  } catch (error) {
    if (!(error instanceof Error)) console.error("preflight command failed with a non-Error value");
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
    "storage-tls": ["curl", ["--fail", "--silent", "--max-time", "5", "--cacert", parityCertificate, "--resolve", `10.0.2.2:${process.env.MATRIX_PARITY_STORAGE_TLS_PORT ?? "9444"}:127.0.0.1`, `https://10.0.2.2:${process.env.MATRIX_PARITY_STORAGE_TLS_PORT ?? "9444"}/minio/health/live`]],
    "speech-tls": ["curl", ["--fail", "--silent", "--max-time", "5", "--cacert", parityCertificate, "--resolve", `10.0.2.2:${process.env.MATRIX_PARITY_SPEECH_TLS_PORT ?? "9445"}:127.0.0.1`, `https://10.0.2.2:${process.env.MATRIX_PARITY_SPEECH_TLS_PORT ?? "9445"}/health`]],
    "shell-proxy": ["curl", ["--insecure", "--fail", "--silent", "--location", "--max-time", "5", "--output", "/dev/null", "--write-out", "%{content_type}", "https://127.0.0.1:8443/sign-in"], (output) => output.toLowerCase().startsWith("text/html")],
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
  // Cold provider discovery on the emulated parity VM can exceed 15 seconds.
  // Leave margin above the product's 30-second readiness deadline.
  const script = `set -a; . /opt/matrix/env/host.env; set +a; curl --silent --show-error --max-time 45 --max-filesize ${MAX_OUTPUT} --write-out '\n%{http_code}' -H 'Authorization: Bearer '"$MATRIX_AUTH_TOKEN" http://127.0.0.1:4000${path}`;
  const remote = [`sudo sh -c ${shellQuote(script)}`];
  try {
    const { stdout } = await execFileAsync("ssh", sshArgs(remote), { cwd: root, timeout: 50_000, maxBuffer: MAX_OUTPUT });
    const marker = stdout.lastIndexOf("\n");
    const body = marker >= 0 ? stdout.slice(0, marker) : "";
    const status = marker >= 0 ? Number(stdout.slice(marker + 1).trim()) : 0;
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    return { status, json };
  } catch (error) {
    if (!(error instanceof Error)) console.error("authenticated request failed with a non-Error value");
    return { status: 0, json: null };
  }
}

async function main() {
  const result = await runPreflight({
    command: commandCheck,
    platformHealth: () => getJson(`http://127.0.0.1:${process.env.MATRIX_PARITY_PLATFORM_PORT ?? "9003"}/health`),
    authenticatedGet,
    chatId: process.env.MATRIX_PREFLIGHT_CHAT_ID,
  });
  for (const check of result.checks) console.log(`${check.level.padEnd(4)} ${check.id}: ${check.detail}`);
  console.log(result.exitCode === 0 ? "READY local demo prerequisites verified" : "NOT READY required local demo prerequisites failed");
  process.exitCode = result.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
    ? "NOT READY preflight timed out safely" : "NOT READY preflight failed safely");
  process.exitCode = 1;
});
