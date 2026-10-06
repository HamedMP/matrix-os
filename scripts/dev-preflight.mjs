#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root, platformPort, storageTlsPort, storageTlsCertificatePath, LOCAL_PARITY_OWNER_LABEL } from "./local-production-parity/config.mjs";
import { sshArguments } from "./local-production-parity/runtime.mjs";
import { parityRouteProbeScript } from "./local-production-parity/recovery.mjs";

const exec = promisify(execFile);
const required = ["docker", "platform-container", "vm-ssh", "runtime-services", "gateway-health", "storage-tls", "shell-proxy", "routed-health"];
const check = (id, ok, detail) => ({ id, level: ok ? "PASS" : "FAIL", detail });

export async function runPreflight({ command = commandCheck, authenticatedGet = ownerGet,
  platformUrl = `http://127.0.0.1:${platformPort}/health`, fetchImpl = fetch } = {}) {
  const checks = [];
  for (const id of required) {
    try { checks.push(check(id, await command(id), "required local transport/service")); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      checks.push(check(id, false, "required check failed"));
    }
  }
  try {
    const response = await fetchImpl(platformUrl, { signal: AbortSignal.timeout(5000), redirect: "error" });
    checks.push(check("platform-health", response.status === 200 && (await response.json())?.status === "ok", "platform health"));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    checks.push(check("platform-health", false, "platform health unavailable"));
  }
  for (const [id, path] of [["capabilities", "/api/integrations/capabilities"], ["integrations", "/api/integrations/available"]]) {
    try {
      const response = await authenticatedGet(path);
      const result = check(id, response.status === 200, response.status === 401 || response.status === 403 ? "owner authentication rejected" : "read-only capability inventory");
      if (id === "integrations" && result.level === "FAIL") result.level = "WARN";
      checks.push(result);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      checks.push({ id, level: id === "integrations" ? "WARN" : "FAIL", detail: "read-only request unavailable" });
    }
  }
  return { checks, exitCode: checks.some(result => result.level === "FAIL") ? 1 : 0 };
}

async function execute(command, args) {
  return (await exec(command, args, { cwd: root, timeout: 50_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

async function commandCheck(id) {
  if (id === "platform-container") {
    const metadata = await execute("docker", ["inspect", "--format", `{{.State.Running}} {{index .Config.Labels "${LOCAL_PARITY_OWNER_LABEL}"}}`, "matrix-os-parity-platform"]);
    return metadata === `true ${root}`;
  }
  const commands = {
    docker: ["docker", ["info"]],
    "vm-ssh": ["ssh", sshArguments(["true"], { strict: true })],
    "runtime-services": ["ssh", sshArguments(["sudo", "systemctl", "is-active", "--quiet", "nginx", "matrix-gateway", "matrix-shell", "matrix-scope-runtime", "matrix-terminal-runtime"], { strict: true })],
    "gateway-health": ["ssh", sshArguments(["curl", "--fail", "--silent", "--max-time", "5", "http://127.0.0.1:4000/health"], { strict: true })],
    "storage-tls": ["curl", ["--fail", "--silent", "--max-time", "5", "--cacert", storageTlsCertificatePath, "--resolve", `10.0.2.2:${storageTlsPort}:127.0.0.1`, `https://10.0.2.2:${storageTlsPort}/minio/health/live`]],
    "shell-proxy": ["curl", ["--insecure", "--fail", "--silent", "--max-time", "5", "--output", "/dev/null", "--write-out", "%{content_type}", "https://127.0.0.1:8443/sign-in"]],
    "routed-health": ["docker", ["exec", "matrix-os-parity-platform", "node", "--input-type=module", "--eval", parityRouteProbeScript(1)]],
  };
  const [command, args] = commands[id];
  const output = await execute(command, args);
  if (id === "gateway-health") return JSON.parse(output)?.status === "ok";
  if (id === "shell-proxy") return output.toLowerCase().startsWith("text/html");
  return true;
}

async function ownerGet(path) {
  // The token stays in the guest and is never included in host arguments/output.
  const script = `set -eu; set -a; . /opt/matrix/env/host.env; set +a; curl --silent --show-error --max-time 45 --max-filesize 1048576 --write-out '\n%{http_code}' -H "Authorization: Bearer $MATRIX_AUTH_TOKEN" http://127.0.0.1:4000${path}`;
  const output = await execute("ssh", sshArguments([`sudo sh -c '${script.replaceAll("'", "'\\''")}'`], { strict: true }));
  const marker = output.lastIndexOf("\n");
  return { status: Number(output.slice(marker + 1)), json: JSON.parse(output.slice(0, marker)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes("--help")) {
    console.log("Read-only production-parity preflight. No Chat, Codex, speech or paid provider requirement. Checks services, verified storage TLS, and owner-authenticated read routes.");
  } else {
    runPreflight().then(result => {
      for (const resultCheck of result.checks) console.log(`${resultCheck.level} ${resultCheck.id}: ${resultCheck.detail}`);
      console.log(result.exitCode === 0 ? "READY local prerequisites; browser/provider turns not verified" : "NOT READY required local prerequisites failed");
      process.exitCode = result.exitCode;
    }).catch(error => {
      console.error(error instanceof Error ? "NOT READY preflight failed safely" : "NOT READY unexpected preflight failure");
      process.exitCode = 1;
    });
  }
}
