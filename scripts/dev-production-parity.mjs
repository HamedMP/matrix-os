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
const builderName = `${machineName}-builder-${randomUUID()}`;
const runtimeDirectory = resolve(stateDirectory, "runtime");
const runtimeDiskPath = resolve(runtimeDirectory, "disk.qcow2");
const runtimeSeedPath = resolve(runtimeDirectory, "cidata.iso");
const runtimePidPath = resolve(runtimeDirectory, "qemu.pid");
const runtimeLogPath = resolve(runtimeDirectory, "serial.log");
const runtimeSshKeyPath = resolve(runtimeDirectory, "operator_ed25519");
const storageTlsDirectory = resolve(stateDirectory, "storage-tls");
const storageTlsCertificatePath = resolve(storageTlsDirectory, "certificate.pem");
const storageTlsKeyPath = resolve(storageTlsDirectory, "key.pem");
const baseImagePath = resolve(stateDirectory, "ubuntu-24.04-amd64.qcow2");
const baseImageChecksumPath = `${baseImagePath}.sha256`;
const artifactPort = Number(process.env.MATRIX_PARITY_ARTIFACT_PORT ?? 9876);
// Keep parity isolated from the source/HMR platform's conventional port 9000.
const platformPort = Number(process.env.MATRIX_PARITY_PLATFORM_PORT ?? 9003);
const storageTlsPort = Number(process.env.MATRIX_PARITY_STORAGE_TLS_PORT ?? 9444);
const guestHostAddress = "10.0.2.2";
const fixturePublicAddress = "192.0.2.2";
const localPlatformUrl = `http://${guestHostAddress}:${platformPort}`;
const localArtifactUrl = `http://${guestHostAddress}:${artifactPort}`;
const ubuntuImageUrl = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img";
const fixtureRouterName = "matrix-os-parity-router";
const storageTlsProxyName = "matrix-os-parity-storage-tls";
const platformContainerName = "matrix-os-parity-platform";
const platformImageName = "matrix-os-parity-platform:working-tree";
export const LOCAL_PARITY_OWNER_LABEL = "com.matrix-os.local-production-parity.root";

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
    "export MATRIX_ZELLIJ_SMOKE_TIMEOUT_MULTIPLIER=10",
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
      "      NODE_EXTRA_CA_CERTS=/opt/matrix/local-parity-storage-ca.pem",
      "      DATABASE_URL=postgresql://matrix:{{postgresPassword}}@127.0.0.1:5432/matrix",
    ].join("\n"),
  );
  rendered = rendered.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => values[key] ?? match);
  return rendered;
}

export function addLocalParityOperator(template, publicKey, storageCertificate) {
  const operator = [
    "  - name: matrix-local-operator",
    "    groups:",
    "      - sudo",
    "    shell: /bin/bash",
    "    sudo: ALL=(ALL) NOPASSWD:ALL",
    "    ssh_authorized_keys:",
    `      - ${publicKey.trim()}`,
  ].join("\n");
  const localTrust = [
    "  - path: /opt/matrix/local-parity-storage-ca.pem",
    "    owner: root:root",
    '    permissions: "0644"',
    "    encoding: b64",
    `    content: ${Buffer.from(storageCertificate).toString("base64")}`,
  ].join("\n");
  const withOperator = template.replace("\nwrite_files:\n", `\n${operator}\n\nwrite_files:\n${localTrust}\n`);
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

export function runAbortableCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    options.signal?.throwIfAborted();
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: options.env ?? process.env,
    });
    const onAbort = () => child.kill("SIGTERM");
    const settle = (callback) => {
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => settle(() => rejectPromise(error)));
    child.once("close", (code, terminationSignal) => settle(() => {
      if (options.signal?.aborted) {
        rejectPromise(options.signal.reason);
      } else if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} ${args.join(" ")} failed (code ${code}, signal ${terminationSignal})`));
      }
    }));
  });
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

export function runtimeProcessPids(options = {}) {
  const diskPath = options.diskPath ?? runtimeDiskPath;
  const processList = options.processList ?? (() => run("ps", ["-axo", "pid=,command="], { capture: true }));
  return processList().split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || !match[2].includes("qemu-system-x86_64") || !match[2].includes(`file=${diskPath}`)) return [];
    return [Number(match[1])];
  });
}

export function assertLocalParityContainerOwnership(name, owner, expectedOwner = root) {
  if (owner !== expectedOwner) {
    throw new Error(`${name} belongs to another checkout; refusing to remove it`);
  }
}

export function assertLocalParityMachinesAvailable(options = {}) {
  const buildName = options.builderName ?? builderName;
  const exists = options.machineExists ?? machineExists;
  const runtimeExists = options.runtimeExists ?? (() => runtimeProcessPids().length > 0);
  const containerExists = options.containerExists ?? ((name) => (
    spawnSync("docker", ["container", "inspect", name], { stdio: "ignore" }).status === 0
  ));
  if (runtimeExists()) {
    throw new Error(`${machineName} QEMU runtime already exists; run dev:parity:down only if you own that environment`);
  }
  if (exists(buildName)) {
    throw new Error(`${buildName} already exists; remove it manually only if you own that OrbStack machine`);
  }
  for (const name of [platformContainerName, fixtureRouterName, storageTlsProxyName]) {
    if (containerExists(name)) {
      throw new Error(`${name} already exists; run dev:parity:down only if you own that environment`);
    }
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

function clerkFrontendApiHost(publishableKey) {
  const match = /^pk_(?:test|live)_([A-Za-z0-9_-]+)$/.exec(publishableKey);
  if (!match) throw new Error("Invalid Clerk publishable key");
  const decoded = Buffer.from(match[1], "base64url").toString("utf8");
  if (!decoded.endsWith("$")) throw new Error("Invalid Clerk publishable key");
  const host = decoded.slice(0, -1);
  const labels = host.split(".");
  if (
    host.length > 253
    || labels.length < 2
    || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  ) {
    throw new Error("Invalid Clerk publishable key");
  }
  return host;
}

export async function fetchConfiguredClerkJwtKey(publishableKey, fetchImpl = fetch) {
  const clerkHost = clerkFrontendApiHost(publishableKey);
  const response = await fetchImpl(`https://${clerkHost}/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Unable to load the configured Clerk public key");
  const body = await response.json();
  const jwk = Array.isArray(body?.keys)
    ? body.keys.find((candidate) => candidate?.kty === "RSA" && candidate?.n && candidate?.e)
    : undefined;
  if (!jwk) throw new Error("Configured Clerk JWKS did not contain an RSA signing key");
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
  for (const command of ["docker", "hdiutil", "openssl", "orb", "pnpm", "qemu-img", "qemu-system-x86_64", "ssh", "ssh-keygen"]) {
    if (spawnSync("which", [command], { stdio: "ignore" }).status !== 0) {
      throw new Error(`${command} is required for production-parity development`);
    }
  }
  if (process.arch === "arm64" && spawnSync("arch", ["-x86_64", "/usr/bin/true"], { stdio: "ignore" }).status !== 0) {
    throw new Error("Rosetta 2 is required for the production x86_64 host bundle and OrbStack machine. Install it with: softwareupdate --install-rosetta --agree-to-license");
  }
  assertOrbStackCapacity();
}

function prepareStorageTlsCertificate() {
  rmSync(storageTlsDirectory, { recursive: true, force: true });
  mkdirSync(storageTlsDirectory, { recursive: true });
  run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "30",
    "-subj", "/CN=matrix-local-parity-storage",
    "-addext", `subjectAltName=IP:${guestHostAddress}`,
    "-keyout", storageTlsKeyPath,
    "-out", storageTlsCertificatePath,
  ]);
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
  const storageCertificate = readFileSync(storageTlsCertificatePath, "utf8");
  writeFileSync(resolve(seedDirectory, "user-data"), addLocalParityOperator(renderedCloudInit, publicKey, storageCertificate), { mode: 0o600 });
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

export function assertFixtureAddressInstalled(isInstalled = fixtureAddressIsInstalled) {
  if (!isInstalled()) {
    throw new Error(
      `The production routing fixture needs an approved one-time host setup. Run: sudo ifconfig lo0 alias ${fixturePublicAddress} netmask 255.255.255.255`,
    );
  }
}

export function fixtureRouterArguments(options = {}) {
  const name = options.name ?? fixtureRouterName;
  const owner = options.owner ?? root;
  return [
    "run", "--detach", "--name", name,
    "--label", `${LOCAL_PARITY_OWNER_LABEL}=${owner}`,
    "--publish", `${fixturePublicAddress}:443:443`,
    "alpine:latest", "sh", "-c",
    "apk add --no-cache socat >/dev/null && exec socat TCP-LISTEN:443,fork,reuseaddr TCP:host.docker.internal:8443",
  ];
}

function startFixtureRouter() {
  run("docker", fixtureRouterArguments());
}

export function storageTlsProxyArguments(options = {}) {
  const name = options.name ?? storageTlsProxyName;
  const owner = options.owner ?? root;
  const port = options.port ?? storageTlsPort;
  const tlsDirectory = options.tlsDirectory ?? storageTlsDirectory;
  return [
    "run", "--detach", "--name", name,
    "--label", `${LOCAL_PARITY_OWNER_LABEL}=${owner}`,
    "--publish", `127.0.0.1:${port}:${port}`,
    "--volume", `${tlsDirectory}:/tls:ro`,
    "alpine:latest", "sh", "-c",
    `apk add --no-cache socat >/dev/null && exec socat OPENSSL-LISTEN:${port},fork,reuseaddr,cert=/tls/certificate.pem,key=/tls/key.pem,verify=0 TCP:host.docker.internal:9100`,
  ];
}

function startStorageTlsProxy() {
  run("docker", storageTlsProxyArguments());
}

function containerExists(name) {
  return spawnSync("docker", ["container", "inspect", name], { stdio: "ignore" }).status === 0;
}

function stopOwnedContainer(name) {
  if (!containerExists(name)) return;
  const owner = run("docker", [
    "container", "inspect", "--format", `{{ index .Config.Labels ${JSON.stringify(LOCAL_PARITY_OWNER_LABEL)} }}`, name,
  ], { capture: true });
  assertLocalParityContainerOwnership(name, owner);
  run("docker", ["rm", "--force", name]);
}

function stopFixtureRouter() {
  stopOwnedContainer(fixtureRouterName);
}

function stopStorageTlsProxy() {
  stopOwnedContainer(storageTlsProxyName);
}

function stopPlatformContainer() {
  stopOwnedContainer(platformContainerName);
}

async function stopQemuRuntime() {
  const candidates = runtimeProcessPids();
  if (candidates.length > 1) {
    throw new Error(`Multiple QEMU processes use ${runtimeDiskPath}; refusing automatic cleanup`);
  }
  const pid = candidates[0];
  if (!pid) {
    const recordedPid = readRuntimePid();
    if (recordedPid) {
      try {
        process.kill(recordedPid, 0);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
        throw error;
      }
      throw new Error(`Process ${recordedPid} is still alive but does not match ${runtimeDiskPath}; refusing to remove the runtime disk`);
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
  }
  const deadline = Date.now() + 30_000;
  while (runtimeProcessPids().includes(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  if (runtimeProcessPids().includes(pid)) {
    throw new Error(`QEMU pid ${pid} did not stop; refusing to remove its disk`);
  }
}

export async function cleanupLocalParityResources(options = {}) {
  const stopRuntime = options.stopRuntime ?? stopQemuRuntime;
  const stopContainers = options.stopContainers ?? [stopFixtureRouter, stopStorageTlsProxy, stopPlatformContainer];
  const removeRuntime = options.removeRuntime ?? (() => rmSync(runtimeDirectory, { recursive: true, force: true }));
  const errors = [];
  let runtimeStopped = false;
  try {
    await stopRuntime();
    runtimeStopped = true;
  } catch (error) {
    errors.push(error);
  }
  for (const stopContainer of stopContainers) {
    try {
      stopContainer();
    } catch (error) {
      errors.push(error);
    }
  }
  if (runtimeStopped) removeRuntime();
  if (errors.length > 0) throw new AggregateError(errors, "Failed to clean up local parity resources safely");
}

function sshArguments(command) {
  return [
    "-i", runtimeSshKeyPath,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=5",
    "-p", "2222",
    "-o", "StrictHostKeyChecking=no",
    "-o", `UserKnownHostsFile=${resolve(runtimeDirectory, "known_hosts")}`,
    "matrix-local-operator@127.0.0.1",
    ...command,
  ];
}

async function waitForRuntimeSsh(timeoutMs = 15 * 60_000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = spawnSync("ssh", sshArguments(["true"]), { cwd: root, stdio: "ignore" });
    if (result.status === 0) return;
    if (!runtimeProcessIsOwned()) throw new Error(`QEMU exited during startup; inspect ${runtimeLogPath}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error(`Timed out waiting for the production VM; inspect ${runtimeLogPath}`);
}

async function waitForRuntimeReadiness(timeoutMs = 30 * 60_000, signal) {
  const deadline = Date.now() + timeoutMs;
  const probe = [
    "sudo", "test", "-f", "/opt/matrix/register-complete", "&&",
    "sudo", "systemctl", "is-active", "--quiet",
    "nginx", "matrix-gateway", "matrix-shell", "matrix-scope-runtime", "matrix-terminal-runtime",
  ];
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = spawnSync("ssh", sshArguments(probe), { cwd: root, stdio: "ignore" });
    if (result.status === 0) return;
    if (!runtimeProcessIsOwned()) throw new Error(`QEMU exited during readiness checks; inspect ${runtimeLogPath}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error("Timed out waiting for production registration and runtime services");
}

function runInRuntime(command, options = {}) {
  return run("ssh", sshArguments(command), options);
}

function runInRuntimeAsync(command, startupSignal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("ssh", sshArguments(command), { cwd: root, stdio: "inherit" });
    const onAbort = () => child.kill("SIGTERM");
    startupSignal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", rejectPromise);
    child.once("exit", (code, terminationSignal) => {
      startupSignal?.removeEventListener("abort", onAbort);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`ssh ${command.join(" ")} failed (code ${code}, signal ${terminationSignal})`));
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

export function lastSuccessfullySeededMachineId(previous) {
  if (previous.stateVersion === 2) {
    return typeof previous.seededMachineId === "string" ? previous.seededMachineId : undefined;
  }
  if (typeof previous.seededMachineId === "string") return previous.seededMachineId;
  return undefined;
}

export function pendingLocalParityMachineId(previous) {
  return typeof previous.machineId === "string" && previous.machineId !== previous.seededMachineId
    ? previous.machineId
    : undefined;
}

function loadState() {
  const env = { ...parseEnvFile(resolve(root, ".env.docker")), ...parseEnvFile(resolve(root, ".env")), ...process.env };
  const clerkUserId = env.MATRIX_LOCAL_CLERK_USER_ID?.trim();
  if (!clerkUserId) {
    throw new Error("MATRIX_LOCAL_CLERK_USER_ID is required so production auth routes the signed-in user to the local machine");
  }
  const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const seededMachineId = lastSuccessfullySeededMachineId(previous);
  const pendingMachineId = pendingLocalParityMachineId(previous);
  const state = {
    ...previous,
    stateVersion: 2,
    machineId: pendingMachineId ?? randomUUID(),
    previousMachineId: seededMachineId,
    seededMachineId: seededMachineId ?? null,
    clerkUserId,
    handle: env.MATRIX_PARITY_HANDLE?.trim() || "local",
    hetznerServerId: 424242,
    platformSecret: randomBytes(32).toString("hex"),
    platformJwtSecret: randomBytes(32).toString("hex"),
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

export function installLocalParitySignalHandlers(signalTarget, controller) {
  const handlers = new Map([
    ["SIGINT", () => controller.abort(new Error("Interrupted by SIGINT"))],
    ["SIGTERM", () => controller.abort(new Error("Interrupted by SIGTERM"))],
  ]);
  for (const [signal, handler] of handlers) signalTarget.on(signal, handler);
  return () => {
    for (const [signal, handler] of handlers) signalTarget.off(signal, handler);
  };
}

export async function buildBundle(plan, options = {}) {
  const execute = options.runCommand ?? runAbortableCommand;
  const exists = options.machineExists ?? machineExists;
  const buildName = options.builderName ?? builderName;
  const signal = options.signal;
  const reuseBundle = options.reuseBundle ?? (
    process.argv.includes("--reuse-bundle") && existsSync(bundlePath) && existsSync(bundleChecksumPath)
  );
  if (reuseBundle) return;
  try {
    signal?.throwIfAborted();
    await execute(plan.builderCreate[0], plan.builderCreate.slice(1), { signal });
    signal?.throwIfAborted();
    await execute("orb", ["-m", buildName, "-u", "root", "bash", "-lc", builderSetupScript()], { signal });
    signal?.throwIfAborted();
    const env = { ...parseEnvFile(resolve(root, ".env")), ...process.env };
    const forwarded = [
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "NEXT_PUBLIC_CLERK_SIGN_IN_URL", "NEXT_PUBLIC_CLERK_SIGN_UP_URL",
      "NEXT_PUBLIC_POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "NEXT_PUBLIC_POSTHOG_HOST", "NEXT_PUBLIC_POSTHOG_API_HOST",
    ];
    if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required to build the production shell");
    const forwardedEnv = Object.fromEntries(forwarded.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]));
    await execute("orb", ["-m", buildName, "-u", "root", "bash", "-lc", plan.buildCommand], {
      signal,
      env: {
        ...process.env,
        ...forwardedEnv,
        ORBENV: Object.keys(forwardedEnv).join(":"),
      },
    });
    signal?.throwIfAborted();
  } finally {
    if (exists(buildName)) await execute("orb", ["delete", "--force", buildName]);
  }
}

async function waitFor(url, timeoutMs = 120_000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
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

export async function startArtifactServer(state, options = {}) {
  const server = createServer((request, response) => {
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
  });
  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => rejectPromise(error);
    server.once("error", onError);
    server.listen(options.port ?? artifactPort, options.host ?? "0.0.0.0", () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
  return server;
}

function publicBuildEnvironment() {
  const env = { ...parseEnvFile(resolve(root, ".env")), ...process.env };
  return {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "",
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? "/sign-in",
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: env.NEXT_PUBLIC_CLERK_SIGN_UP_URL ?? "/sign-up",
    NEXT_PUBLIC_POSTHOG_KEY: env.NEXT_PUBLIC_POSTHOG_KEY ?? "",
    NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? "",
    NEXT_PUBLIC_POSTHOG_HOST: env.NEXT_PUBLIC_POSTHOG_HOST ?? "",
    NEXT_PUBLIC_POSTHOG_API_HOST: env.NEXT_PUBLIC_POSTHOG_API_HOST ?? "",
    NEXT_PUBLIC_MATRIX_APP_URL: `http://app.localhost:${platformPort}`,
  };
}

export function clerkSecretIsConfigured(value) {
  return /^sk_(?:test|live)_[A-Za-z0-9_-]{16,}$/.test(value?.trim() ?? "");
}

function configuredClerkSecret(value) {
  if (!clerkSecretIsConfigured(value)) return "";
  return value.trim();
}

export function platformImageBuildArguments(publicEnv, options = {}) {
  const imageName = options.imageName ?? platformImageName;
  const args = ["build", "--file", "Dockerfile.platform", "--tag", imageName];
  for (const [key, value] of Object.entries(publicEnv)) {
    args.push("--build-arg", `${key}=${value}`);
  }
  args.push(".");
  return args;
}

export function platformEnvironment(state, clerkJwtKey) {
  const localEnv = { ...parseEnvFile(resolve(root, ".env.docker")), ...parseEnvFile(resolve(root, ".env")), ...process.env };
  const clerkSecret = configuredClerkSecret(localEnv.CLERK_SECRET_KEY);
  const hasClerkCredential = clerkSecret.length > 0;
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...publicBuildEnvironment(),
    AUTH_SHELL_ENABLED: String(hasClerkCredential),
    AUTH_SHELL_CLERK_SECRET_KEY: clerkSecret,
    ...(!hasClerkCredential && { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "" }),
    CLERK_JWT_KEY: clerkJwtKey,
    PLATFORM_RUNTIME_MODE: "local",
    PLATFORM_PREVIEW: "true",
    PLATFORM_BACKGROUND_WORKERS_ENABLED: "false",
    CUSTOMER_VPS_ENABLED: "true",
    CUSTOMER_VPS_CLOUD_INIT_PATH: "distro/customer-vps/cloud-init.yaml",
    GOLDEN_SNAPSHOT_BUILDER_CLOUD_INIT_PATH: "distro/customer-vps/golden-snapshot-builder-cloud-init.yaml",
    GOLDEN_SNAPSHOT_OPERATOR_SECRET: createHmac("sha256", state.platformSecret).update("local-golden-snapshot-operator").digest("hex"),
    GOLDEN_SNAPSHOTS_ENABLED: "false",
    GOLDEN_SNAPSHOT_BUILDS_ENABLED: "false",
    MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: "false",
    MATRIX_BIND_HOST: "0.0.0.0",
    PLATFORM_PORT: "8080",
    PLATFORM_PUBLIC_URL: localPlatformUrl,
    PLATFORM_DATABASE_URL: "postgresql://matrixos:matrixos@host.docker.internal:5432/matrixos_platform",
    PLATFORM_SECRET: state.platformSecret,
    PLATFORM_JWT_SECRET: state.platformJwtSecret,
    CUSTOMER_VPS_TLS_VERIFY: "false",
    S3_ENDPOINT: "http://host.docker.internal:9100",
    S3_PUBLIC_ENDPOINT: `https://${guestHostAddress}:${storageTlsPort}`,
    S3_ACCESS_KEY_ID: "matrixos",
    S3_SECRET_ACCESS_KEY: "matrixos123",
    S3_BUCKET: "matrixos-sync",
    S3_FORCE_PATH_STYLE: "true",
    S3_BUNDLES_ENDPOINT: "http://host.docker.internal:9100",
    S3_BUNDLES_PUBLIC_ENDPOINT: `https://${guestHostAddress}:${storageTlsPort}`,
    S3_BUNDLES_ACCESS_KEY_ID: "matrixos",
    S3_BUNDLES_SECRET_ACCESS_KEY: "matrixos123",
    S3_BUNDLES_BUCKET: "matrixos-host-bundles",
    S3_BUNDLES_FORCE_PATH_STYLE: "true",
  };
}

export function platformContainerArguments(env, options = {}) {
  const containerName = options.containerName ?? platformContainerName;
  const imageName = options.imageName ?? platformImageName;
  const hostPort = options.hostPort ?? platformPort;
  const owner = options.owner ?? root;
  const args = [
    "run", "--detach", "--name", containerName,
    "--label", `${LOCAL_PARITY_OWNER_LABEL}=${owner}`,
    "--publish", `0.0.0.0:${hostPort}:8080`,
  ];
  for (const key of Object.keys(env)) args.push("--env", key);
  args.push(imageName);
  return args;
}

function startPlatformContainer(env) {
  run("docker", platformContainerArguments(env), { env });
}

async function up() {
  assertPrerequisites();
  assertLocalParityMachinesAvailable({ machineName, builderName });
  await Promise.all([
    assertTcpPortAvailable(platformPort),
    assertTcpPortAvailable(artifactPort),
    assertTcpPortAvailable(storageTlsPort),
  ]);
  assertFixtureAddressInstalled();
  const publicEnv = publicBuildEnvironment();
  if (!publicEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required to build the production platform image");
  }
  const clerkJwtKey = await fetchConfiguredClerkJwtKey(publicEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const state = loadState();
  const plan = createLocalParityPlan({ root, machineName, builderName });
  const shutdown = new AbortController();
  const removeSignalHandlers = installLocalParitySignalHandlers(process, shutdown);
  let artifactServer;
  let ready = false;
  try {
    await buildBundle(plan, { signal: shutdown.signal });
    const configuredEnv = { ...parseEnvFile(resolve(root, ".env.docker")), ...parseEnvFile(resolve(root, ".env")), ...process.env };
    if (!clerkSecretIsConfigured(configuredEnv.CLERK_SECRET_KEY)) {
      console.warn("CLERK_SECRET_KEY is unavailable; browser auth will return a bounded unavailable response, while the production VM still starts");
    }
    run("docker", platformImageBuildArguments(publicEnv));
    prepareBaseImage();
    prepareStorageTlsCertificate();
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
    run("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "--detach", "postgres", "minio", "minio-alias", "minio-init"]);
    shutdown.signal.throwIfAborted();
    startFixtureRouter();
    await waitFor("http://127.0.0.1:9100/minio/health/live", 120_000, shutdown.signal);
    startStorageTlsProxy();
    const env = platformEnvironment(state, clerkJwtKey);
    run("pnpm", ["exec", "tsx", "scripts/dev-production-parity-seed.ts"], {
      env: {
        ...env,
        PLATFORM_DATABASE_URL: "postgresql://matrixos:matrixos@127.0.0.1:5432/matrixos_platform",
      },
    });
    state.seededMachineId = state.machineId;
    delete state.previousMachineId;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    artifactServer = await startArtifactServer(state);
    startPlatformContainer(env);
    await waitFor(`http://127.0.0.1:${platformPort}/health`, 120_000, shutdown.signal);
    startQemuRuntime();
    await waitForRuntimeSsh(15 * 60_000, shutdown.signal);
    // Keep the event loop available to serve the host bundle while cloud-init
    // downloads and installs it in the guest.
    await runInRuntimeAsync(["sudo", "cloud-init", "status", "--wait", "--long"], shutdown.signal);
    await waitForRuntimeReadiness(30 * 60_000, shutdown.signal);
    ready = true;
    console.log(`\nProduction-parity VM is ready. Platform: http://127.0.0.1:${platformPort}`);
    console.log(`Machine: https://${fixturePublicAddress} (production auth still applies)`);
    console.log("Keep this process running; Ctrl+C stops only the local platform and artifact server.\n");
    await new Promise((resolvePromise) => {
      if (shutdown.signal.aborted) resolvePromise();
      else shutdown.signal.addEventListener("abort", resolvePromise, { once: true });
    });
  } catch (error) {
    try {
      await cleanupLocalParityResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Local parity startup and cleanup both failed");
    }
    throw error;
  } finally {
    removeSignalHandlers();
    artifactServer?.close();
    if (ready) stopPlatformContainer();
  }
}

async function down() {
  await cleanupLocalParityResources();
}

function status() {
  if (!runtimeProcessIsOwned()) {
    console.log(`${machineName}: absent`);
    return;
  }
  console.log(`${machineName}: QEMU pid ${readRuntimePid()} (Ubuntu 24.04 amd64, TCG)`);
  run("docker", ["ps", "--filter", `name=^/${platformContainerName}$`, "--format", "{{.Names}}: {{.Status}}"]);
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
  if (spawnSync("docker", ["container", "inspect", platformContainerName], { stdio: "ignore" }).status === 0) {
    run("docker", ["logs", "--tail", "300", platformContainerName]);
  }
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
