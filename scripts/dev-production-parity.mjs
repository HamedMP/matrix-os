#!/usr/bin/env node

import { createHmac, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDirectory = resolve(root, ".amp/in/local-production-parity");
const statePath = resolve(stateDirectory, "state.json");
const bundleDirectory = resolve(stateDirectory, "host-bundle");
const cloudInitPath = resolve(stateDirectory, "cloud-init.yaml");
const bundlePath = resolve(bundleDirectory, "matrix-host-bundle.tar.gz");
const bundleChecksumPath = `${bundlePath}.sha256`;
const machineName = process.env.MATRIX_PARITY_MACHINE_NAME ?? "matrix-os-local";
const builderName = `${machineName}-builder`;
const runtimeDirectory = resolve(stateDirectory, "runtime");
const runtimeDiskPath = resolve(runtimeDirectory, "disk.qcow2");
const runtimeSeedPath = resolve(runtimeDirectory, "cidata.iso");
const runtimePidPath = resolve(runtimeDirectory, "qemu.pid");
const runtimeLogPath = resolve(runtimeDirectory, "serial.log");
const runtimeSshKeyPath = resolve(runtimeDirectory, "operator_ed25519");
const baseImagePath = resolve(stateDirectory, "ubuntu-24.04-amd64.qcow2");
const baseImageChecksumPath = `${baseImagePath}.sha256`;
const artifactPort = Number(process.env.MATRIX_PARITY_ARTIFACT_PORT ?? 9876);
// Keep parity isolated from the source/HMR platform's conventional port 9000.
const platformPort = Number(process.env.MATRIX_PARITY_PLATFORM_PORT ?? 9003);
const guestHostAddress = "10.0.2.2";
const fixturePublicAddress = "192.0.2.2";
const localPlatformUrl = `http://${guestHostAddress}:${platformPort}`;
const localArtifactUrl = `http://${guestHostAddress}:${artifactPort}`;
const ubuntuImageUrl = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img";
const fixtureRouterName = "matrix-os-parity-router";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runtimeToken(kind, identity, secret) {
  return createHmac("sha256", secret)
    .update(JSON.stringify([kind, 1, identity.handle, identity.machineId, identity.runtimeSlot]))
    .digest("hex");
}

export function createLocalParityPlan(options = {}) {
  const projectRoot = options.root ?? root;
  const runtimeName = options.machineName ?? machineName;
  const buildName = options.builderName ?? `${runtimeName}-builder`;
  const generatedCloudInitPath = resolve(projectRoot, ".amp/in/local-production-parity/cloud-init.yaml");
  const sourcePath = `/mnt/mac${projectRoot}`;
  const buildCommand = [
    "set -euo pipefail",
    `exec > >(tee ${shellQuote(`/mnt/mac${stateDirectory}/builder.log`)}) 2>&1`,
    "rm -rf /var/tmp/matrix-os-source",
    "mkdir -p /var/tmp/matrix-os-source",
    `rsync -a --delete --exclude=.env --exclude='.env.*' --exclude=.amp --exclude=node_modules --exclude=dist --exclude='.next' ${shellQuote(`${sourcePath}/`)} /var/tmp/matrix-os-source/`,
    "cd /var/tmp/matrix-os-source",
    "export NODE_OPTIONS=--max-old-space-size=2048",
    "export ERL_AFLAGS='+JMsingle true'",
    "export npm_config_jobs=1",
    "export MAKEFLAGS=-j1",
    "export MATRIX_LOCAL_PARITY_BUILD=1",
    "export MATRIX_ZELLIJ_SMOKE_TIMEOUT_MULTIPLIER=4",
    "pnpm install --frozen-lockfile --network-concurrency=4 --child-concurrency=1",
    "./scripts/build-host-bundle.sh",
    `install -D -m 0644 dist/host-bundle/matrix-host-bundle.tar.gz ${shellQuote(`/mnt/mac${bundlePath}`)}`,
    `install -D -m 0644 dist/host-bundle/matrix-host-bundle.tar.gz.sha256 ${shellQuote(`/mnt/mac${bundleChecksumPath}`)}`,
  ].join("\n");

  return {
    cloudInitPath: generatedCloudInitPath,
    builderCreate: [
      "orb", "create", "--arch", "amd64", "--memory", "4G", "--cpus", "2",
      "--disk", "64G", "ubuntu:noble", buildName,
    ],
    buildCommand,
  };
}

export function renderLocalParityCloudInit(template, input) {
  const identity = { handle: input.handle, machineId: input.machineId, runtimeSlot: "primary" };
  const verificationToken = createHmac("sha256", input.platformSecret).update(input.handle).digest("hex");
  const artifactOrigin = new URL(input.hostBundleUrl).origin;
  const values = {
    machineId: input.machineId,
    clerkUserId: input.clerkUserId,
    handle: input.handle,
    runtimeSlot: "primary",
    runtimeTokenEpoch: "1",
    developerTools: "codex pi",
    imageVersion: "local-working-tree",
    updateChannel: "dev",
    imageSource: "clean_image",
    targetBundleSha256: input.bundleSha256 ?? "",
    snapshotSourceVersion: "",
    hostBundleUrl: input.hostBundleUrl,
    platformRegisterUrl: `${input.platformUrl}/vps/register`,
    platformInternalUrl: input.platformUrl,
    platformVerificationToken: verificationToken,
    syncRuntimeToken: runtimeToken("matrix-sync-runtime", identity, input.platformSecret),
    fundedAiRuntimeToken: runtimeToken("matrix-funded-ai-runtime", identity, input.platformSecret),
    platformSpeechEnabled: "false",
    platformSpeechOrigin: input.platformUrl,
    platformSpeechRuntimeToken: runtimeToken("matrix-platform-speech-runtime", identity, input.platformSecret),
    registrationToken: input.registrationToken,
    registrationTokenExpiresAt: input.registrationTokenExpiresAt,
    postgresPassword: input.postgresPassword,
    posthogToken: "",
    posthogProjectToken: "",
    posthogHost: "",
    posthogPublicHost: "https://eu.posthog.com",
    posthogApiHost: "/relay",
    fundedAiEnabled: "false",
    fundedAiRelayUrl: "",
  };
  let rendered = template;
  rendered = rendered.replace(
    "      DATABASE_URL=postgresql://matrix:{{postgresPassword}}@127.0.0.1:5432/matrix",
    [
      `      MATRIX_METADATA_INSTANCE_ID_URL=${artifactOrigin}/metadata/instance-id`,
      `      MATRIX_METADATA_PUBLIC_IPV4_URL=${artifactOrigin}/metadata/public-ipv4`,
      "      DATABASE_URL=postgresql://matrix:{{postgresPassword}}@127.0.0.1:5432/matrix",
    ].join("\n"),
  );
  rendered = rendered.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => values[key] ?? match);
  return rendered;
}

export function addLocalParityOperator(template, publicKey) {
  const operator = [
    "  - name: matrix-local-operator",
    "    groups:",
    "      - sudo",
    "    shell: /bin/bash",
    "    sudo: ALL=(ALL) NOPASSWD:ALL",
    "    ssh_authorized_keys:",
    `      - ${publicKey.trim()}`,
  ].join("\n");
  const withOperator = template.replace("\nwrite_files:\n", `\n${operator}\n\nwrite_files:\n`);
  return withOperator.replace(
    "#cloud-config\n",
    [
      "#cloud-config",
      "# Local-only routable fixture address. Production registration and routing remain unchanged.",
      "bootcmd:",
      "  - |",
      "    interface=$(ip route show default | awk '{print $5; exit}')",
      `    ip address replace ${fixturePublicAddress}/32 dev "$interface"`,
      "",
    ].join("\n"),
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", env: options.env ?? process.env });
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stderr || result.stdout}`.trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function machineExists(name) {
  return spawnSync("orb", ["info", name, "--format", "json"], { stdio: "ignore" }).status === 0;
}

function readRuntimePid() {
  if (!existsSync(runtimePidPath)) return null;
  const pid = Number(readFileSync(runtimePidPath, "utf8").trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

export function runtimeProcessIsOwned(options = {}) {
  const pid = options.pid ?? readRuntimePid();
  const diskPath = options.diskPath ?? runtimeDiskPath;
  const processCommand = options.processCommand ?? ((candidatePid) => {
    const result = spawnSync("ps", ["-p", String(candidatePid), "-o", "command="], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "";
  });
  return pid !== null && processCommand(pid).includes(diskPath);
}

export function assertLocalParityMachinesAvailable(options = {}) {
  const buildName = options.builderName ?? builderName;
  const exists = options.machineExists ?? machineExists;
  const runtimeExists = options.runtimeExists ?? runtimeProcessIsOwned;
  if (runtimeExists()) {
    throw new Error(`${machineName} QEMU runtime already exists; run dev:parity:down only if you own that environment`);
  }
  if (exists(buildName)) {
    throw new Error(`${buildName} already exists; run dev:parity:down only if you own that environment`);
  }
}

export async function assertTcpPortAvailable(port, host = "0.0.0.0") {
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      rejectPromise(new Error(`TCP port ${port} is already accepting loopback connections; refusing to accept another process as ready`));
    });
    socket.once("timeout", () => {
      socket.destroy();
      rejectPromise(new Error(`Timed out checking TCP port ${port}`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolvePromise();
      else rejectPromise(new Error(`Unable to verify TCP port ${port}`, { cause: error }));
    });
  });
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createTcpServer();
    server.once("error", (error) => {
      rejectPromise(new Error(`TCP port ${port} is already in use; refusing to accept another process as ready`, { cause: error }));
    });
    server.listen(port, host, () => server.close(resolvePromise));
  });
}

export async function fetchProductionClerkJwtKey(fetchImpl = fetch) {
  const response = await fetchImpl("https://clerk.matrix-os.com/.well-known/jwks.json", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Unable to load the production Clerk public key");
  const body = await response.json();
  const jwk = Array.isArray(body?.keys)
    ? body.keys.find((candidate) => candidate?.kty === "RSA" && candidate?.n && candidate?.e)
    : undefined;
  if (!jwk) throw new Error("Production Clerk JWKS did not contain an RSA signing key");
  return createPublicKey({ key: jwk, format: "jwk" })
    .export({ type: "spki", format: "pem" })
    .toString();
}

export function assertOrbStackCapacity(
  readMemoryLimit = () => run("orb", ["config", "get", "memory_mib"], { capture: true }),
) {
  const memoryMiB = Number(readMemoryLimit());
  if (!Number.isFinite(memoryMiB) || memoryMiB < 6144) {
    throw new Error(
      "OrbStack needs a 6 GiB shared memory limit for the bundle builder and local dependencies. Run: orb config set memory_mib 6144 && orb stop",
    );
  }
}

function assertPrerequisites() {
  for (const command of ["docker", "hdiutil", "orb", "pnpm", "qemu-img", "qemu-system-x86_64", "ssh", "ssh-keygen"]) {
    if (spawnSync("which", [command], { stdio: "ignore" }).status !== 0) {
      throw new Error(`${command} is required for production-parity development`);
    }
  }
  if (process.arch === "arm64" && spawnSync("arch", ["-x86_64", "/usr/bin/true"], { stdio: "ignore" }).status !== 0) {
    throw new Error("Rosetta 2 is required for the production x86_64 host bundle and OrbStack machine. Install it with: softwareupdate --install-rosetta --agree-to-license");
  }
  assertOrbStackCapacity();
}

function prepareBaseImage() {
  if (existsSync(baseImagePath) && existsSync(baseImageChecksumPath)) {
    run("shasum", ["-a", "256", "-c", baseImageChecksumPath]);
    return;
  }
  mkdirSync(stateDirectory, { recursive: true });
  const sumsPath = resolve(stateDirectory, "SHA256SUMS");
  if (!existsSync(baseImagePath)) {
    run("curl", ["--fail", "--location", "--retry", "3", "--connect-timeout", "10", "--max-time", "1800", ubuntuImageUrl, "-o", baseImagePath]);
  }
  run("curl", ["--fail", "--location", "--retry", "3", "--connect-timeout", "10", "--max-time", "120", `${new URL(".", ubuntuImageUrl)}SHA256SUMS`, "-o", sumsPath]);
  const imageName = new URL(ubuntuImageUrl).pathname.split("/").at(-1);
  const checksumLine = readFileSync(sumsPath, "utf8").split("\n").find((line) => line.trim().endsWith(`*${imageName}`));
  if (!checksumLine) throw new Error(`Ubuntu checksum manifest did not contain ${imageName}`);
  const checksum = checksumLine.trim().split(/\s+/)[0];
  writeFileSync(baseImageChecksumPath, `${checksum}  ${baseImagePath}\n`);
  run("shasum", ["-a", "256", "-c", baseImageChecksumPath]);
}

function prepareRuntimeFiles(renderedCloudInit, instanceId) {
  rmSync(runtimeDirectory, { recursive: true, force: true });
  mkdirSync(runtimeDirectory, { recursive: true });
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "matrix-local-parity", "-f", runtimeSshKeyPath]);
  const publicKey = readFileSync(`${runtimeSshKeyPath}.pub`, "utf8").trim();
  const seedDirectory = resolve(runtimeDirectory, "seed");
  mkdirSync(seedDirectory, { recursive: true });
  writeFileSync(resolve(seedDirectory, "user-data"), addLocalParityOperator(renderedCloudInit, publicKey), { mode: 0o600 });
  writeFileSync(resolve(seedDirectory, "meta-data"), `instance-id: ${instanceId}\nlocal-hostname: ${machineName}\n`, { mode: 0o600 });
  run("hdiutil", ["makehybrid", "-quiet", "-iso", "-joliet", "-default-volume-name", "cidata", "-o", runtimeSeedPath, seedDirectory]);
  run("qemu-img", ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", baseImagePath, runtimeDiskPath, "64G"]);
}

export function qemuRuntimeArguments(options = {}) {
  const diskPath = options.diskPath ?? runtimeDiskPath;
  const seedPath = options.seedPath ?? runtimeSeedPath;
  const logPath = options.logPath ?? runtimeLogPath;
  return [
    "-name", machineName,
    "-machine", "q35,accel=tcg",
    "-cpu", "max",
    "-smp", "2",
    "-m", "4096",
    "-display", "none",
    "-serial", `file:${logPath}`,
    "-drive", `if=virtio,format=qcow2,file=${diskPath}`,
    "-drive", `if=virtio,format=raw,readonly=on,file=${seedPath}`,
    "-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:8443-:443",
    "-device", "virtio-net-pci,netdev=net0,mac=52:54:00:4d:58:01",
    "-no-reboot",
  ];
}

function startQemuRuntime() {
  const output = openSync(resolve(runtimeDirectory, "qemu.log"), "a");
  // QEMU resolves firmware relative to its installation. Run the installed
  // executable rather than copying it away from Homebrew's share/qemu data.
  const qemuExecutable = run("which", ["qemu-system-x86_64"], { capture: true });
  const child = spawn(qemuExecutable, qemuRuntimeArguments(), {
    cwd: root,
    stdio: ["ignore", output, output],
  });
  closeSync(output);
  if (!child.pid) throw new Error("QEMU did not return a process id");
  writeFileSync(runtimePidPath, `${child.pid}\n`, { mode: 0o600 });
}

function fixtureAddressIsInstalled() {
  return run("ifconfig", ["lo0"], { capture: true }).includes(`inet ${fixturePublicAddress} `);
}

function installFixtureAddress() {
  if (!fixtureAddressIsInstalled()) run("sudo", ["ifconfig", "lo0", "alias", fixturePublicAddress, "netmask", "255.255.255.255"]);
}

function removeFixtureAddress() {
  if (!fixtureAddressIsInstalled()) return;
  const result = spawnSync("sudo", ["ifconfig", "lo0", "-alias", fixturePublicAddress], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
}

function startFixtureRouter() {
  if (spawnSync("docker", ["container", "inspect", fixtureRouterName], { stdio: "ignore" }).status === 0) {
    throw new Error(`${fixtureRouterName} already exists; run dev:parity:down only if you own it`);
  }
  run("docker", [
    "run", "--detach", "--name", fixtureRouterName,
    "--publish", `${fixturePublicAddress}:443:443`,
    "alpine:latest", "sh", "-c",
    "apk add --no-cache socat >/dev/null && exec socat TCP-LISTEN:443,fork,reuseaddr TCP:host.docker.internal:8443",
  ]);
}

function stopFixtureRouter() {
  if (spawnSync("docker", ["container", "inspect", fixtureRouterName], { stdio: "ignore" }).status === 0) {
    run("docker", ["rm", "--force", fixtureRouterName]);
  }
}

function sshArguments(command) {
  return [
    "-i", runtimeSshKeyPath,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-p", "2222",
    "-o", "StrictHostKeyChecking=no",
    "-o", `UserKnownHostsFile=${resolve(runtimeDirectory, "known_hosts")}`,
    "matrix-local-operator@127.0.0.1",
    ...command,
  ];
}

async function waitForRuntimeSsh(timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync("ssh", sshArguments(["true"]), { cwd: root, stdio: "ignore" });
    if (result.status === 0) return;
    if (!runtimeProcessIsOwned()) throw new Error(`QEMU exited during startup; inspect ${runtimeLogPath}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error(`Timed out waiting for the production VM; inspect ${runtimeLogPath}`);
}

function runInRuntime(command, options = {}) {
  return run("ssh", sshArguments(command), options);
}

function runInRuntimeAsync(command) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("ssh", sshArguments(command), { cwd: root, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`ssh ${command.join(" ")} failed (code ${code}, signal ${signal})`));
    });
  });
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

function loadState() {
  const env = { ...parseEnvFile(resolve(root, ".env.docker")), ...parseEnvFile(resolve(root, ".env")), ...process.env };
  const clerkUserId = env.MATRIX_LOCAL_CLERK_USER_ID?.trim();
  if (!clerkUserId) {
    throw new Error("MATRIX_LOCAL_CLERK_USER_ID is required so production auth routes the signed-in user to the local machine");
  }
  const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const state = {
    ...previous,
    machineId: randomUUID(),
    clerkUserId,
    handle: env.MATRIX_PARITY_HANDLE?.trim() || "local",
    hetznerServerId: 424242,
    platformSecret: randomBytes(32).toString("hex"),
    registrationToken: randomBytes(32).toString("base64url"),
    registrationTokenExpiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    postgresPassword: randomBytes(24).toString("base64url"),
  };
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

export function builderSetupScript() {
  const nodeVersion = readFileSync(resolve(root, ".nvmrc"), "utf8").trim();
  const pnpmVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).packageManager.split("@")[1];
  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
fallocate -l 8G /matrix-build.swap
chmod 0600 /matrix-build.swap
mkswap /matrix-build.swap
swapon /matrix-build.swap
apt-get update
apt-get install -y build-essential ca-certificates curl git python3 rsync unzip xz-utils
curl --fail --location --retry 3 --connect-timeout 10 --max-time 180 https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
corepack enable
corepack prepare pnpm@${pnpmVersion} --activate
curl --fail --location --retry 3 --connect-timeout 10 --max-time 120 https://bun.sh/install | bash
ln -sf /root/.bun/bin/bun /usr/local/bin/bun
otp_build=$(curl -fsSL https://builds.hex.pm/builds/otp/amd64/ubuntu-24.04/builds.txt | awk '$1 ~ /^OTP-28([.][0-9]+)*$/ { print $1 }' | sort -V | tail -1)
test -n "$otp_build"
mkdir -p /opt/beam/otp
curl --fail --location --retry 3 --connect-timeout 10 --max-time 300 "https://builds.hex.pm/builds/otp/amd64/ubuntu-24.04/\${otp_build}.tar.gz" -o /tmp/otp.tar.gz
tar -xzf /tmp/otp.tar.gz --strip-components=1 -C /opt/beam/otp
/opt/beam/otp/Install -minimal /opt/beam/otp
export PATH=/opt/beam/otp/bin:$PATH
elixir_build=$(curl -fsSL https://builds.hex.pm/builds/elixir/builds.txt | awk '$1 ~ /^v1[.]19([.][0-9]+)*-otp-28$/ { print $1 }' | sort -V | tail -1)
test -n "$elixir_build"
mkdir -p /opt/beam/elixir
curl --fail --location --retry 3 --connect-timeout 10 --max-time 180 "https://builds.hex.pm/builds/elixir/\${elixir_build}.zip" -o /tmp/elixir.zip
unzip -q /tmp/elixir.zip -d /opt/beam/elixir
ln -sf /opt/beam/otp/bin/* /usr/local/bin/
ln -sf /opt/beam/elixir/bin/* /usr/local/bin/
`;
}

function buildBundle(plan) {
  if (process.argv.includes("--reuse-bundle") && existsSync(bundlePath) && existsSync(bundleChecksumPath)) return;
  run(plan.builderCreate[0], plan.builderCreate.slice(1));
  try {
    run("orb", ["-m", builderName, "-u", "root", "bash", "-lc", builderSetupScript()]);
    const env = { ...parseEnvFile(resolve(root, ".env")), ...process.env };
    const forwarded = [
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "NEXT_PUBLIC_CLERK_SIGN_IN_URL", "NEXT_PUBLIC_CLERK_SIGN_UP_URL",
      "NEXT_PUBLIC_POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "NEXT_PUBLIC_POSTHOG_HOST", "NEXT_PUBLIC_POSTHOG_API_HOST",
    ];
    if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required to build the production shell");
    const forwardedEnv = Object.fromEntries(forwarded.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]));
    run("orb", ["-m", builderName, "-u", "root", "bash", "-lc", plan.buildCommand], {
      env: {
        ...process.env,
        ...forwardedEnv,
        ORBENV: Object.keys(forwardedEnv).join(":"),
      },
    });
  } finally {
    if (machineExists(builderName)) run("orb", ["delete", "--force", builderName]);
  }
}

async function waitFor(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof TypeError || error?.name === "TimeoutError")) throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startArtifactServer(state) {
  return createServer((request, response) => {
    if (request.url === "/health") return response.end("ok\n");
    if (request.url === "/metadata/instance-id") return response.end(`${state.hetznerServerId}\n`);
    if (request.url === "/metadata/public-ipv4") return response.end(`${fixturePublicAddress}\n`);
    const path = request.url === "/matrix-host-bundle.tar.gz" ? bundlePath
      : request.url === "/matrix-host-bundle.tar.gz.sha256" ? bundleChecksumPath : null;
    if (!path || !existsSync(path)) {
      response.statusCode = 404;
      return response.end("not found\n");
    }
    createReadStream(path).pipe(response);
  }).listen(artifactPort, "0.0.0.0");
}

function platformEnvironment(state, clerkJwtKey) {
  return {
    ...process.env,
    CLERK_SECRET_KEY: "",
    CLERK_JWT_KEY: clerkJwtKey,
    PLATFORM_RUNTIME_MODE: "local",
    PLATFORM_BACKGROUND_WORKERS_ENABLED: "false",
    CUSTOMER_VPS_ENABLED: "true",
    CUSTOMER_VPS_CLOUD_INIT_PATH: resolve(root, "distro/customer-vps/cloud-init.yaml"),
    GOLDEN_SNAPSHOT_BUILDER_CLOUD_INIT_PATH: resolve(root, "distro/customer-vps/golden-snapshot-builder-cloud-init.yaml"),
    GOLDEN_SNAPSHOT_OPERATOR_SECRET: createHmac("sha256", state.platformSecret).update("local-golden-snapshot-operator").digest("hex"),
    GOLDEN_SNAPSHOTS_ENABLED: "false",
    GOLDEN_SNAPSHOT_BUILDS_ENABLED: "false",
    MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: "false",
    MATRIX_BIND_HOST: "0.0.0.0",
    PLATFORM_PORT: String(platformPort),
    PLATFORM_PUBLIC_URL: localPlatformUrl,
    PLATFORM_DATABASE_URL: "postgresql://matrixos:matrixos@127.0.0.1:5432/matrixos_platform",
    PLATFORM_SECRET: state.platformSecret,
    CUSTOMER_VPS_TLS_VERIFY: "false",
    S3_ENDPOINT: "http://127.0.0.1:9100",
    S3_PUBLIC_ENDPOINT: "http://127.0.0.1:9100",
    S3_ACCESS_KEY_ID: "matrixos",
    S3_SECRET_ACCESS_KEY: "matrixos123",
    S3_BUCKET: "matrixos-sync",
    S3_FORCE_PATH_STYLE: "true",
    S3_BUNDLES_ENDPOINT: "http://127.0.0.1:9100",
    S3_BUNDLES_PUBLIC_ENDPOINT: `http://${guestHostAddress}:9100`,
    S3_BUNDLES_ACCESS_KEY_ID: "matrixos",
    S3_BUNDLES_SECRET_ACCESS_KEY: "matrixos123",
    S3_BUNDLES_BUCKET: "matrixos-host-bundles",
    S3_BUNDLES_FORCE_PATH_STYLE: "true",
  };
}

async function up() {
  assertPrerequisites();
  assertLocalParityMachinesAvailable({ machineName, builderName });
  await Promise.all([
    assertTcpPortAvailable(platformPort),
    assertTcpPortAvailable(artifactPort),
  ]);
  const clerkJwtKey = await fetchProductionClerkJwtKey();
  const state = loadState();
  const plan = createLocalParityPlan({ root, machineName, builderName });
  buildBundle(plan);
  prepareBaseImage();
  state.bundleSha256 = readFileSync(bundleChecksumPath, "utf8").trim().split(/\s+/)[0];
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const template = readFileSync(resolve(root, "distro/customer-vps/cloud-init.yaml"), "utf8");
  const rendered = renderLocalParityCloudInit(template, {
    ...state,
    hostBundleUrl: `${localArtifactUrl}/matrix-host-bundle.tar.gz`,
    platformUrl: localPlatformUrl,
  });
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(cloudInitPath, rendered, { mode: 0o600 });
  prepareRuntimeFiles(rendered, state.machineId);
  installFixtureAddress();
  state.fixtureAddressInstalled = true;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  run("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "--detach", "postgres", "minio", "minio-alias", "minio-init"]);
  startFixtureRouter();
  await waitFor("http://127.0.0.1:9100/minio/health/live");
  const env = platformEnvironment(state, clerkJwtKey);
  run("pnpm", ["exec", "tsx", "scripts/dev-production-parity-seed.ts"], { env });
  const artifactServer = startArtifactServer(state);
  const platform = spawn("pnpm", ["--filter", "@matrix-os/platform", "dev"], {
    cwd: root,
    detached: process.platform !== "win32",
    env,
    stdio: "inherit",
  });
  try {
    await Promise.race([
      waitFor(`http://127.0.0.1:${platformPort}/health`),
      new Promise((_, rejectPromise) => {
        platform.once("exit", (code, signal) => rejectPromise(new Error(`platform stopped before readiness (code ${code}, signal ${signal})`)));
      }),
    ]);
    startQemuRuntime();
    await waitForRuntimeSsh();
    // Keep the event loop available to serve the host bundle while cloud-init
    // downloads and installs it in the guest.
    await runInRuntimeAsync(["sudo", "cloud-init", "status", "--wait", "--long"]);
    console.log(`\nProduction-parity VM is ready. Platform: http://127.0.0.1:${platformPort}`);
    console.log(`Machine: https://${fixturePublicAddress} (production auth still applies)`);
    console.log("Keep this process running; Ctrl+C stops only the local platform and artifact server.\n");
    await new Promise((resolvePromise, rejectPromise) => {
      platform.once("exit", (code, signal) => code === 0 || signal ? resolvePromise() : rejectPromise(new Error(`platform exited with code ${code}`)));
      process.once("SIGINT", resolvePromise);
      process.once("SIGTERM", resolvePromise);
    });
  } finally {
    artifactServer.close();
    if (platform.exitCode === null && platform.pid !== undefined) {
      if (process.platform === "win32") platform.kill("SIGTERM");
      else process.kill(-platform.pid, "SIGTERM");
    }
  }
}

async function down() {
  const pid = readRuntimePid();
  if (runtimeProcessIsOwned({ pid })) {
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 30_000;
    while (runtimeProcessIsOwned({ pid }) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    if (runtimeProcessIsOwned({ pid })) {
      throw new Error(`QEMU pid ${pid} did not stop; refusing to remove its disk`);
    }
  }
  stopFixtureRouter();
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state.fixtureAddressInstalled) removeFixtureAddress();
  }
  rmSync(runtimeDirectory, { recursive: true, force: true });
  if (machineExists(builderName)) run("orb", ["delete", "--force", builderName]);
  run("docker", ["compose", "-f", "docker-compose.dev.yml", "stop", "postgres", "minio"]);
}

function status() {
  if (!runtimeProcessIsOwned()) {
    console.log(`${machineName}: absent`);
    return;
  }
  console.log(`${machineName}: QEMU pid ${readRuntimePid()} (Ubuntu 24.04 amd64, TCG)`);
  runInRuntime(["sudo", "cloud-init", "status", "--long"]);
  const checks = [
    ["systemctl", "--no-pager", "--failed"],
    ["systemctl", "--no-pager", "status", "matrix-gateway.service", "matrix-shell.service", "matrix-terminal-runtime.service", "nginx"],
  ];
  for (const args of checks) {
    const result = spawnSync("ssh", sshArguments(["sudo", ...args]), { cwd: root, encoding: "utf8", stdio: "inherit" });
    if (result.error) throw result.error;
  }
}

function logs() {
  if (!runtimeProcessIsOwned()) throw new Error(`${machineName} does not exist`);
  if (existsSync(runtimeLogPath)) process.stdout.write(readFileSync(runtimeLogPath, "utf8"));
  runInRuntime(["sudo", "journalctl", "--no-pager", "-n", "300", "-u", "cloud-final.service", "-u", "matrix-gateway.service", "-u", "matrix-shell.service", "-u", "matrix-terminal-runtime.service", "-u", "matrix-vps-registration.service"]);
}

const command = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  const action = command === "up" ? up : command === "down" ? down : command === "status" ? status : command === "logs" ? logs : undefined;
  Promise.resolve().then(() => {
    if (!action) throw new Error("usage: dev-production-parity.mjs <up|down|status|logs> [--reuse-bundle]");
    return action();
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
