import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { recoverLocalParity } from "../../scripts/local-production-parity/recovery.mjs";
import { resolveParityStateDirectory } from "../../scripts/local-production-parity/config.mjs";
import { loadState } from "../../scripts/dev-production-parity.mjs";

const checkouts: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of checkouts.splice(0)) rmSync(root, { recursive: true, force: true });
});

function savedEnvironment() {
  const root = mkdtempSync(resolve(tmpdir(), "parity-recovery-"));
  checkouts.push(root);
  const saved = resolve(root, ".local/production-parity");
  const files = ["runtime/disk.qcow2", "runtime/cidata.iso", "runtime/operator_ed25519", "runtime/known_hosts",
    "ubuntu-24.04-amd64.qcow2", "storage-tls/certificate.pem", "storage-tls/key.pem"];
  const state = { machineId: "saved-machine", seededMachineId: "saved-machine", clerkUserId: "owner",
    platformSecret: "retained-platform-secret", platformJwtSecret: "retained-jwt-secret", handle: "local" };
  for (const file of files) {
    mkdirSync(dirname(resolve(saved, file)), { recursive: true });
    writeFileSync(resolve(saved, file), `retained ${file}`);
  }
  writeFileSync(resolve(saved, "state.json"), JSON.stringify(state));
  const containers = new Map<string, { owner: string; running: boolean }>();
  containers.set("matrix-os-parity-platform", { owner: root, running: false });
  const containerEnvironments = new Map<string, Record<string, string | undefined>>();
  const effects: string[] = [];
  const services = new Set(["matrix-gateway", "matrix-shell"]);
  let volumeMissing = false;
  let routeFailure = false;
  let processes = "";
  let failRestart = false;
  const run = (command: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}) => {
    const key = `${command} ${args.join(" ")}`;
    if (command === "ps") return processes;
    if (key === "docker context show") return "orbstack";
    if (args[0] === "info") return "28.0.0";
    if (args[0] === "ps") return [...containers.keys()].join("\n");
    if (args[0] === "inspect") {
      const container = containers.get(args.at(-1)!);
      if (!container) throw new Error("missing container");
      return args[2].includes("State.Running") ? String(container.running) : container.owner;
    }
    if (args[0] === "volume") { if (volumeMissing) throw new Error("missing volume"); return args.at(-1)!; }
    if (args.includes("config")) return JSON.stringify({ name: "demo", services: { postgres: {}, minio: {} },
      volumes: { pgdata: { name: "retained-postgres" }, "minio-data": { name: "retained-minio" } } });
    if (args[0] === "image") return "retained-image";
    if (args[0] === "exec") { if (routeFailure) throw new Error("route unreachable"); return "routed gateway ready"; }
    if (command === "ssh") {
      if (options.input?.includes("systemctl stop matrix-shell matrix-gateway")) services.clear();
      if (options.input?.includes("systemctl start matrix-gateway matrix-shell")) {
        services.add("matrix-gateway"); services.add("matrix-shell");
      }
      effects.push(args.join(" ")); return "";
    }
    if (command === "qemu-system-x86_64") {
      effects.push(key);
      processes = `777 qemu-system-x86_64 -drive file=${saved}/runtime/disk.qcow2`;
      return "";
    }
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1];
      if (name === "matrix-os-parity-platform") {
        expect(options.env?.PLATFORM_SECRET).toBe(state.platformSecret);
        expect(options.env?.PLATFORM_JWT_SECRET).toBe(state.platformJwtSecret);
        // Docker --env NAME copies only named variables from the CLI environment.
        const forwarded: Record<string, string | undefined> = {};
        for (let index = 0; index < args.length; index++) {
          if (args[index] === "--env") forwarded[args[index + 1]] = options.env?.[args[index + 1]];
        }
        containerEnvironments.set(name, forwarded);
      }
      containers.set(name, { owner: root, running: true }); effects.push(key); return "";
    }
    if (args[0] === "start" || args[0] === "restart") {
      if (failRestart && args[0] === "restart") throw new Error("restart interrupted");
      for (const name of args.slice(1)) if (containers.has(name)) containers.get(name)!.running = true;
      effects.push(key); return "";
    }
    if (args.includes("up")) { effects.push(key); return ""; }
    throw new Error(`Unexpected external operation: ${key}`);
  };
  const options = { root, saved, run, checkPort: async () => {}, assertAddress: () => {},
    checkCertificate: () => {},
    sleep: async () => {}, log: () => {} };
  const original = ["state.json", ...files].map(file => [file, readFileSync(resolve(saved, file))] as const);
  const preserved = () => { for (const [file, content] of original) expect(readFileSync(resolve(saved, file))).toEqual(content); };
  return { root, saved, options, containers, containerEnvironments, effects, services, preserved,
    missingVolume: () => { volumeMissing = true; }, brokenRoute: () => { routeFailure = true; },
    restoreRoute: () => { routeFailure = false; },
    duplicateVm: () => { processes = `10 qemu-system-x86_64 -drive file=${saved}/runtime/disk.qcow2\n11 qemu-system-x86_64 -drive file=${saved}/runtime/disk.qcow2`; },
    interruptedRestart: () => { failRestart = true; } };
}

it("resumes the same owner VM and credentials, and retry does not launch a duplicate VM", async () => {
  const env = savedEnvironment();
  await recoverLocalParity(env.options);
  await recoverLocalParity(env.options);
  env.preserved();
  expect(env.containers.get("matrix-os-parity-platform")?.running).toBe(true);
  expect(env.containers.get("matrix-os-parity-platform-tls")?.running).toBe(true);
  expect(env.effects.find(effect => effect.includes("--name matrix-os-parity-platform-tls"))).toContain("TCP:host.docker.internal:9003");
  expect(env.effects.filter(effect => effect.startsWith("qemu-system-x86_64"))).toHaveLength(1);
  expect(env.effects.filter(effect => effect.includes("compose"))).toEqual([
    `docker compose -f ${env.root}/docker-compose.dev.yml up --detach --no-recreate --no-build --wait --wait-timeout 120 postgres minio`,
    `docker compose -f ${env.root}/docker-compose.dev.yml up --detach --no-recreate --no-build --wait --wait-timeout 120 postgres minio`,
  ]);
});

it("refuses replacement before rotating a retained VM's identity or credentials, leaving it resumable", async () => {
  const env = savedEnvironment();
  vi.stubEnv("MATRIX_LOCAL_CLERK_USER_ID", "owner");
  expect(() => loadState({ projectRoot: env.root })).toThrow(/resume.*restart/);
  env.preserved();
  await recoverLocalParity(env.options);
  env.preserved();
  expect(env.effects).toContain("docker start matrix-os-parity-platform");
  rmSync(resolve(env.saved, "runtime"), { recursive: true });
  const replacement = loadState({ projectRoot: env.root });
  expect(replacement.previousMachineId).toBe("saved-machine");
  expect(replacement.machineId).not.toBe("saved-machine");
});

it("recreates the platform with retained credentials without leaking host secrets or macOS paths", async () => {
  const env = savedEnvironment();
  env.containers.delete("matrix-os-parity-platform");
  vi.stubEnv("HOST_PRIVATE_TOKEN", "host-only-secret");
  vi.stubEnv("TMPDIR", "/host-only/temp/");
  vi.stubEnv("SSH_AUTH_SOCK", "/host-only/ssh-agent");
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", `pk_test_${Buffer.from("clerk.example.com$").toString("base64url")}`);
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubGlobal("fetch", async () => Response.json({ keys: [publicKey.export({ format: "jwk" })] }));

  // Use production environment selection; fake only the JWKS and process I/O.
  await recoverLocalParity({ ...env.options, loadPlatformEnv: undefined });
  const forwarded = env.containerEnvironments.get("matrix-os-parity-platform")!;
  expect(forwarded.PLATFORM_SECRET).toBe("retained-platform-secret");
  expect(forwarded.PLATFORM_JWT_SECRET).toBe("retained-jwt-secret");
  for (const hostOnly of ["HOST_PRIVATE_TOKEN", "TMPDIR", "SSH_AUTH_SOCK", "HOME", "PATH"]) {
    expect(forwarded).not.toHaveProperty(hostOnly);
  }
  env.preserved();
});

it("restarts the owned TLS bridge alongside the retained platform", async () => {
  const env = savedEnvironment();
  await recoverLocalParity({ ...env.options, restart: true });
  expect(env.effects.find(effect => effect.startsWith("docker restart"))).toContain("matrix-os-parity-platform-tls");
  env.preserved();
});

it.each(["foreign platform", "foreign bridge", "foreign database", "missing volume", "missing disk", "duplicate VM", "occupied VM port", "legacy certificate"])(
  "refuses %s before changing resources or retained data", async (failure) => {
    const env = savedEnvironment();
    if (failure === "foreign platform") env.containers.set("matrix-os-parity-platform", { owner: "/another/checkout", running: false });
    if (failure === "foreign bridge") env.containers.set("matrix-os-parity-platform-tls", { owner: "/another/checkout", running: false });
    if (failure === "legacy certificate") env.options.checkCertificate = () => { throw new Error("manual certificate migration required"); };
    if (failure === "foreign database") env.containers.set("demo-postgres-1", { owner: "/another/checkout", running: true });
    if (failure === "missing volume") env.missingVolume();
    if (failure === "missing disk") rmSync(resolve(env.saved, "runtime/disk.qcow2"));
    if (failure === "duplicate VM") env.duplicateVm();
    if (failure === "occupied VM port") env.options.checkPort = async () => { throw new Error("foreign service owns SSH port"); };
    await expect(recoverLocalParity(env.options)).rejects.toThrow();
    expect(env.effects).toEqual([]);
    expect(readFileSync(resolve(env.saved, "state.json"), "utf8")).toContain('"machineId":"saved-machine"');
    expect(readFileSync(resolve(env.saved, "runtime/operator_ed25519"), "utf8")).toBe("retained runtime/operator_ed25519");
    expect(readFileSync(resolve(env.saved, "runtime/cidata.iso"), "utf8")).toBe("retained runtime/cidata.iso");
  },
);

it("preserves user data on route failure and allows a later retry", async () => {
  const env = savedEnvironment();
  env.brokenRoute();
  await expect(recoverLocalParity(env.options)).rejects.toThrow();
  env.preserved();
  expect(env.containers.get("matrix-os-parity-platform")?.running).toBe(true);
  env.restoreRoute();
  await recoverLocalParity(env.options);
  env.preserved();
});

it("attempts to restore gateway and shell after a failed restart without deleting the VM", async () => {
  const env = savedEnvironment();
  env.interruptedRestart();
  await expect(recoverLocalParity({ ...env.options, restart: true })).rejects.toThrow();
  env.preserved();
  expect([...env.services]).toEqual(["matrix-gateway", "matrix-shell"]);
});

it("keeps legacy disks, mounts and locks at their original path, and refuses two saved environments", () => {
  const env = savedEnvironment();
  expect(resolveParityStateDirectory(env.root)).toBe(env.saved);
  rmSync(env.saved, { recursive: true });
  const legacy = resolve(env.root, ".amp/in/local-production-parity");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(resolve(legacy, "state.json"), "retained identity");
  expect(resolveParityStateDirectory(env.root)).toBe(legacy);
  mkdirSync(env.saved, { recursive: true });
  expect(() => resolveParityStateDirectory(env.root)).toThrow();
  expect(readFileSync(resolve(legacy, "state.json"), "utf8")).toBe("retained identity");
});
