// Resume a provisioned local demo. Never call parity `up`: it replaces the disk.
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  assertLocalParityContainerOwnership, assertTcpPortAvailable, fetchConfiguredClerkJwtKey,
  fixtureRouterArguments, platformContainerArguments, platformEnvironment, publicBuildEnvironment,
  qemuRuntimeArguments, runtimeProcessPids, speechTlsProxyArguments, storageTlsProxyArguments,
} from "./dev-production-parity.mjs";

async function savedPlatformEnvironment(state, root) {
  const env = {};
  for (const name of [".env.docker", ".env"]) {
    const path = resolve(root, name);
    if (existsSync(path)) Object.assign(env, parseEnv(readFileSync(path, "utf8")));
  }
  Object.assign(env, process.env);
  const publicEnv = publicBuildEnvironment(env);
  if (!publicEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) throw new Error("Restore this checkout's Clerk configuration before recreating its platform.");
  const key = await fetchConfiguredClerkJwtKey(publicEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  return { ...platformEnvironment(state, key, env), ...publicEnv };
}

export async function recoverLocalDemo({ root, run, sshArgs, log = console.log,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  checkPort = assertTcpPortAvailable, loadPlatformEnv = savedPlatformEnvironment }) {
  const saved = resolve(root, ".amp/in/local-production-parity");
  const runtime = resolve(saved, "runtime");
  // Fail before starting anything when the retained data cannot be recovered.
  for (const file of ["state.json", "runtime/disk.qcow2", "runtime/cidata.iso", "runtime/operator_ed25519",
    "runtime/known_hosts", "ubuntu-24.04-amd64.qcow2", "storage-tls/certificate.pem", "storage-tls/key.pem"]) {
    if (!existsSync(resolve(saved, file))) throw new Error(`Missing saved demo file: ${file}. Restore it from backup; refusing to provision over existing data.`);
  }
  const state = JSON.parse(readFileSync(resolve(saved, "state.json"), "utf8"));
  if (!state.machineId || state.machineId !== state.seededMachineId || !state.platformSecret || !state.platformJwtSecret || !state.clerkUserId) {
    throw new Error("Saved demo identity is incomplete or was never seeded; refusing credential rotation or database reseeding.");
  }
  if (run("docker", ["context", "show"]).trim() !== "orbstack") {
    throw new Error("Select the local OrbStack Docker context first: docker context use orbstack");
  }
  async function waitForCommand(label, command, args, options, attempts) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { return run(command, args, options); }
      catch (error) {
        if (attempt === attempts) throw new Error(`${label} did not become ready; recovery stopped.`, { cause: error });
        log(`Waiting for ${label} (${attempt}/${attempts})...`);
        await sleep(2000);
      }
    }
  }
  try { run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 }); }
  catch (error) {
    log(`Starting OrbStack (${error instanceof Error ? error.message : "Docker unavailable"}).`);
    run("open", ["-a", "OrbStack"]);
    await waitForCommand("Docker", "docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 }, 30);
  }

  const existing = new Set(run("docker", ["ps", "-a", "--format", "{{.Names}}"]).trim().split("\n"));
  const platform = "matrix-os-parity-platform";
  const stagingPlatform = `${platform}-recovery`;
  const proxies = [
    ["matrix-os-parity-router", fixtureRouterArguments({ owner: root })],
    ["matrix-os-parity-storage-tls", storageTlsProxyArguments({ owner: root, tlsDirectory: resolve(saved, "storage-tls") })],
    ["matrix-os-parity-speech-tls", speechTlsProxyArguments({ owner: root, tlsDirectory: resolve(saved, "storage-tls") })],
  ];
  for (const name of [platform, stagingPlatform, ...proxies.map(([name]) => name)]) {
    if (existing.has(name)) assertLocalParityContainerOwnership(name,
      run("docker", ["inspect", "--format", '{{index .Config.Labels "com.matrix-os.local-production-parity.root"}}', name]).trim(), root);
  }
  if (existing.has(stagingPlatform) && run("docker", ["inspect", "--format", "{{.State.Running}}", stagingPlatform]).trim() !== "false") {
    throw new Error("A platform recovery container is already running; refusing to replace it.");
  }
  const compose = ["compose", "-f", resolve(root, "docker-compose.dev.yml")];
  const config = JSON.parse(run("docker", [...compose, "config", "--format", "json"], { cwd: root }));
  for (const service of ["postgres", "minio"]) {
    const name = `${config.name}-${service}-1`;
    if (existing.has(name)) assertLocalParityContainerOwnership(name,
      run("docker", ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project.working_dir"}}', name]).trim(), root);
  }
  for (const volume of ["pgdata", "minio-data"]) {
    const name = config.volumes?.[volume]?.name;
    if (!name) throw new Error(`Missing ${volume} volume configuration; refusing to create an empty replacement.`);
    try { run("docker", ["volume", "inspect", "--format", "{{.Name}}", name]); }
    catch (error) { throw new Error(`Retained ${volume} volume is missing. Restore the volume from backup; refusing to start with empty data.`, { cause: error }); }
  }
  const pids = runtimeProcessPids({ diskPath: resolve(runtime, "disk.qcow2"), processList: () => run("ps", ["-axo", "pid=,command="]) });
  if (pids.length > 1) throw new Error("Multiple QEMU processes reference the saved disk; refusing to start another.");
  if (pids.length === 0) { await checkPort(2222); await checkPort(8443); }
  let platformEnv;
  if (!existing.has(platform)) {
    run("docker", ["image", "inspect", "--format", "{{.Id}}", "matrix-os-parity-platform:working-tree"]);
    platformEnv = await loadPlatformEnv(state, root);
  }
  if (!/inet 192\.0\.2\.2\b/.test(run("ifconfig", ["lo0"]))) {
    log("Restoring the local routing alias (may require: sudo ifconfig lo0 alias 192.0.2.2 netmask 255.255.255.255).");
    run("sudo", ["-n", "ifconfig", "lo0", "alias", "192.0.2.2", "netmask", "255.255.255.255"]);
  }
  log("Starting retained database/storage containers; preserving their volumes.");
  run("docker", [...compose, "up", "--detach", "--no-recreate", "--no-build", "--wait", "--wait-timeout", "120", "postgres", "minio"], { cwd: root });
  for (const [name, args] of proxies) run("docker", existing.has(name) ? ["start", name] : args);
  if (platformEnv) {
    log("Recreating the missing platform from its existing image and saved identity; restoring current speech modules.");
    const temporary = mkdtempSync(resolve(saved, "speech-recovery-"));
    let created = false;
    try {
      run("pnpm", ["exec", "esbuild", "packages/platform/src/speech/adapters/openai.ts", "packages/platform/src/speech/wiring.ts",
        "--outbase=packages/platform/src", `--outdir=${temporary}`, "--format=esm", "--platform=node", "--target=node24"], { cwd: root });
      if (existing.has(stagingPlatform)) run("docker", ["rm", stagingPlatform]);
      const args = platformContainerArguments(platformEnv, { owner: root, containerName: stagingPlatform });
      args[0] = "create"; args.splice(args.indexOf("--detach"), 1);
      run("docker", args, { env: { ...process.env, ...platformEnv } }); created = true;
      for (const file of ["speech/adapters/openai.js", "speech/wiring.js"]) {
        run("docker", ["cp", resolve(temporary, file), `${stagingPlatform}:/app/packages/platform/dist/${file}`]);
      }
      run("docker", ["rename", stagingPlatform, platform]);
      created = false;
    } catch (error) {
      if (created) run("docker", ["rm", stagingPlatform]); // Only this new, never-started, incomplete container.
      throw error;
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  run("docker", ["start", platform]);
  if (pids.length === 0) {
    log("Booting the saved QEMU disk (no provisioning or bundle rebuild).");
    run("qemu-system-x86_64", [...qemuRuntimeArguments({ diskPath: resolve(runtime, "disk.qcow2"),
      seedPath: resolve(runtime, "cidata.iso"), logPath: resolve(runtime, "serial.log") }),
      "-daemonize", "-pidfile", resolve(runtime, "qemu.pid")]);
  }
  await waitForCommand("VM SSH", "ssh", sshArgs, { input: "true\n", timeout: 12_000 }, 60);
}
