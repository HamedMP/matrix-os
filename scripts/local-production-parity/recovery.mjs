import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertFixtureAddressInstalled, assertLocalParityContainerOwnership, assertTcpPortAvailable,
  fetchConfiguredClerkJwtKey, fixtureRouterArguments, platformContainerArguments,
  platformEnvironment, publicBuildEnvironment, storageTlsProxyArguments,
} from "../dev-production-parity.mjs";
import { root as projectRoot, resolveParityStateDirectory } from "./config.mjs";
import { qemuRuntimeArguments, runtimeProcessPids, sshArguments } from "./runtime.mjs";

export function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? projectRoot, encoding: "utf8",
    timeout: options.timeout ?? 120_000, maxBuffer: 1024 * 1024,
    input: options.input, env: options.env ?? process.env, stdio: "pipe" });
  // Do not print subprocess output: Docker/SSH failures can contain credentials.
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed; saved data was not removed`);
  return result.stdout.trim();
}

async function savedPlatformEnvironment(state) {
  const publicEnv = publicBuildEnvironment();
  if (!publicEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) throw new Error("Restore this checkout's Clerk configuration before resuming its platform");
  const key = await fetchConfiguredClerkJwtKey(publicEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  return { ...process.env, ...platformEnvironment(state, key) };
}

// Serialized into the platform container. No imports or captured bindings.
export async function waitForParityRoute(fetchImpl, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 24) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl("https://192.0.2.2/health", { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (response.status === 200 && (await response.json())?.status === "ok") return;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    if (attempt < attempts) await sleep(5000);
  }
  throw new Error("Platform -> router -> VM health did not become ready; services and saved data were left intact");
}

const startServices = `set -euo pipefail
wait_http() {
  local url="$1" deadline=$((SECONDS + $2))
  until curl -fsS --max-time 5 -o /dev/null "$url" 2>/dev/null; do
    if (( SECONDS >= deadline )); then echo "HTTP readiness timed out" >&2; exit 1; fi
    sleep 5
  done
}
test -f /opt/matrix/register-complete
systemctl start nginx matrix-scope-runtime matrix-terminal-runtime matrix-gateway
wait_http http://127.0.0.1:4000/health 420
systemctl start matrix-shell
wait_http http://127.0.0.1:3000/health 120
systemctl is-active --quiet nginx matrix-gateway matrix-shell matrix-scope-runtime matrix-terminal-runtime
`;

export async function recoverLocalParity({ root = projectRoot, saved = resolveParityStateDirectory(root), run = execute,
  restart = false, checkPort = assertTcpPortAvailable, assertAddress = assertFixtureAddressInstalled,
  loadPlatformEnv = savedPlatformEnvironment, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log } = {}) {
  const runtime = resolve(saved, "runtime");
  for (const file of ["state.json", "runtime/disk.qcow2", "runtime/cidata.iso", "runtime/operator_ed25519",
    "runtime/known_hosts", "ubuntu-24.04-amd64.qcow2", "storage-tls/certificate.pem", "storage-tls/key.pem"]) {
    if (!existsSync(resolve(saved, file))) throw new Error(`Missing saved parity file: ${file}; restore it instead of provisioning a replacement`);
  }
  const state = JSON.parse(readFileSync(resolve(saved, "state.json"), "utf8"));
  if (!state.machineId || state.machineId !== state.seededMachineId || !state.platformSecret || !state.platformJwtSecret || !state.clerkUserId) {
    throw new Error("Saved identity is incomplete or was never seeded; refusing credential rotation or database reseeding");
  }
  if (run("docker", ["context", "show"]) !== "orbstack") throw new Error("Select the local OrbStack Docker context before recovery");
  async function waitForCommand(label, command, args, options, attempts) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { return run(command, args, options); }
      catch (error) {
        if (attempt === attempts) throw new Error(`${label} did not become ready; saved data was left intact`, { cause: error });
        await sleep(2000);
      }
    }
  }
  try { run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 }); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    log("Starting the local OrbStack engine");
    run("orb", ["start"]);
    await waitForCommand("Docker", "docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 }, 30);
  }
  const existing = new Set(run("docker", ["ps", "-a", "--format", "{{.Names}}"]).split("\n"));
  const platform = "matrix-os-parity-platform";
  const proxies = [
    ["matrix-os-parity-router", fixtureRouterArguments({ owner: root })],
    ["matrix-os-parity-storage-tls", storageTlsProxyArguments({ owner: root, tlsDirectory: resolve(saved, "storage-tls") })],
  ];
  for (const name of [platform, ...proxies.map(([name]) => name)]) {
    if (existing.has(name)) assertLocalParityContainerOwnership(name,
      run("docker", ["inspect", "--format", '{{index .Config.Labels "com.matrix-os.local-production-parity.root"}}', name]), root);
  }
  const compose = ["compose", "-f", resolve(root, "docker-compose.dev.yml")];
  const config = JSON.parse(run("docker", [...compose, "config", "--format", "json"], { cwd: root }));
  for (const service of ["postgres", "minio"]) {
    const name = config.services[service].container_name ?? `${config.name}-${service}-1`;
    if (existing.has(name)) assertLocalParityContainerOwnership(name,
      run("docker", ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project.working_dir"}}', name]), root);
  }
  for (const volume of ["pgdata", "minio-data"]) {
    const name = config.volumes?.[volume]?.name;
    if (!name) throw new Error(`Missing ${volume} volume configuration; refusing an empty replacement`);
    run("docker", ["volume", "inspect", "--format", "{{.Name}}", name]);
  }
  const pids = runtimeProcessPids({ diskPath: resolve(runtime, "disk.qcow2"), processList: () => run("ps", ["-axo", "pid=,command="]) });
  if (pids.length > 1) throw new Error("Multiple QEMU processes reference the saved disk; refusing another VM");
  if (pids.length === 0) { await checkPort(2222); await checkPort(8443); }
  let platformEnv;
  if (!existing.has(platform)) {
    run("docker", ["image", "inspect", "--format", "{{.Id}}", "matrix-os-parity-platform:working-tree"]);
    platformEnv = await loadPlatformEnv(state);
  }
  assertAddress();
  log("Resuming retained dependencies, VM and credentials without provisioning or rebuilding");
  run("docker", [...compose, "up", "--detach", "--no-recreate", "--no-build", "--wait", "--wait-timeout", "120", "postgres", "minio"], { cwd: root });
  for (const [name, args] of proxies) run("docker", existing.has(name) ? ["start", name] : args);
  run("docker", platformEnv ? platformContainerArguments(platformEnv, { owner: root }) : ["start", platform], { env: platformEnv });
  if (pids.length === 0) run("qemu-system-x86_64", [...qemuRuntimeArguments({ diskPath: resolve(runtime, "disk.qcow2"),
    seedPath: resolve(runtime, "cidata.iso"), logPath: resolve(runtime, "serial.log") }), "-daemonize", "-pidfile", resolve(runtime, "qemu.pid")]);
  const remote = input => run("ssh", sshArguments(["sudo", "-n", "bash", "-s"], { runtime, strict: true }), { input, timeout: 600_000 });
  await waitForCommand("VM SSH", "ssh", sshArguments(["true"], { runtime, strict: true }), { timeout: 12_000 }, 60);
  let restoreServices = false;
  try {
    if (restart) {
      restoreServices = true;
      remote("set -e\nsystemctl stop matrix-shell matrix-gateway\n");
      run("docker", ["restart", platform, ...proxies.map(([name]) => name)]);
    }
    remote(startServices);
    restoreServices = false;
    run("docker", ["exec", "-i", platform, "node", "--input-type=module"], { timeout: 270_000,
      input: `import { fetch, Agent } from 'undici';
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
try { await (${waitForParityRoute.toString()})((url, options) => fetch(url, { ...options, dispatcher })); }
finally { await dispatcher.close(); }
` });
    log("Ready: VM services and platform -> router -> gateway health. Browser auth and provider turns are not verified.");
  } finally {
    if (restoreServices) remote("set -e\nsystemctl start matrix-gateway matrix-shell\n");
  }
}
