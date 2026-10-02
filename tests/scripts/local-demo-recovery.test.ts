import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverLocalDemo } from "../../scripts/local-demo-recovery.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture({ missing = [] as string[], liveVm = false, foreign = "", engineDown = false, interruptedCreate = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "matrix-resume-")); roots.push(root);
  const saved = join(root, ".amp/in/local-production-parity");
  const state = { machineId: "saved-machine", seededMachineId: "saved-machine", clerkUserId: "owner",
    platformSecret: "retained-secret", platformJwtSecret: "retained-jwt" };
  const files = ["runtime/disk.qcow2", "runtime/cidata.iso", "runtime/operator_ed25519", "runtime/known_hosts",
    "ubuntu-24.04-amd64.qcow2", "storage-tls/certificate.pem", "storage-tls/key.pem"];
  for (const file of files) {
    mkdirSync(join(saved, file, ".."), { recursive: true }); writeFileSync(join(saved, file), "retained data");
  }
  writeFileSync(join(saved, "state.json"), JSON.stringify(state));
  writeFileSync(join(root, ".env"), "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_fixture\n");
  const names = ["matrix-os-parity-platform", "matrix-os-parity-router", "matrix-os-parity-storage-tls",
    "matrix-os-parity-speech-tls", "fixture-postgres-1", "fixture-minio-1"].filter(n => !missing.includes(n));
  if (interruptedCreate) names.push("matrix-os-parity-platform-recovery");
  const run = vi.fn((command: string, args: string[], _options?: any): string => {
    if (command === "docker" && args[0] === "context") return "orbstack";
    if (command === "docker" && args[0] === "info" && engineDown) { engineDown = false; throw new Error("Docker stopped"); }
    if (command === "docker" && args[0] === "ps") return names.join("\n");
    if (command === "docker" && args.includes("{{.State.Running}}")) return "false";
    if (command === "docker" && args[0] === "inspect") return args.at(-1) === foreign ? "/other-checkout" : root;
    if (command === "docker" && args[0] === "compose" && args.includes("config")) {
      return JSON.stringify({ name: "fixture", volumes: { pgdata: { name: "fixture_pgdata" }, "minio-data": { name: "fixture_minio-data" } } });
    }
    if (command === "ps" && liveVm) return `876 qemu-system-x86_64 -drive if=virtio,format=qcow2,file=${saved}/runtime/disk.qcow2`;
    if (command === "ifconfig") return "inet 192.0.2.2 netmask 0xffffffff";
    return "";
  });
  const sleep = vi.fn(async () => {});
  const checkPort = vi.fn(async () => {});
  const loadPlatformEnv = vi.fn(async (input: any) => ({ PLATFORM_SECRET: input.platformSecret, PLATFORM_JWT_SECRET: input.platformJwtSecret }));
  return { root, saved, run, sleep, checkPort, loadPlatformEnv,
    invoke: () => recoverLocalDemo({ root, run, sleep, checkPort, loadPlatformEnv, sshArgs: ["fixture-ssh"], log: vi.fn() }) };
}

describe("saved local demo recovery (no real services)", () => {
  it("boots the existing disk after a full shutdown and preserves stopped containers", async () => {
    const h = fixture({ engineDown: true });
    await h.invoke();
    expect(h.run.mock.calls.some(([c, a]) => c === "open" && a.join(" ") === "-a OrbStack")).toBe(true);
    const qemu = h.run.mock.calls.find(([c]) => c === "qemu-system-x86_64")!;
    expect(qemu[1]).toContain(`if=virtio,format=qcow2,file=${h.saved}/runtime/disk.qcow2`);
    expect(qemu[1]).toContain("-daemonize");
    expect(qemu[1]).toContain("-pidfile");
    expect(h.checkPort.mock.calls.map(([p]) => p)).toEqual([2222, 8443]);
    expect(h.run.mock.calls.some(([c, a]) => c === "docker" && a[0] === "start" && a.includes("matrix-os-parity-platform"))).toBe(true);
    expect(h.run.mock.calls.some(([c, a]) => c === "docker" && ["create", "run", "rm", "build"].includes(a[0]))).toBe(false);
    expect(readFileSync(join(h.saved, "runtime/disk.qcow2"), "utf8")).toBe("retained data");
    expect(JSON.parse(readFileSync(join(h.saved, "state.json"), "utf8")).platformSecret).toBe("retained-secret");
  });

  it("recreates missing platform and proxies without rotating identity, rebuilding images or reseeding data", async () => {
    const h = fixture({ missing: ["matrix-os-parity-platform", "matrix-os-parity-router", "matrix-os-parity-speech-tls"] });
    await h.invoke();
    expect(h.loadPlatformEnv).toHaveBeenCalledWith(expect.objectContaining({ machineId: "saved-machine", platformSecret: "retained-secret" }), h.root);
    const platform = h.run.mock.calls.find(([c, a]) => c === "docker" && a[0] === "create")!;
    expect(platform[1]).toContain("matrix-os-parity-platform-recovery");
    expect(platform[2].env.PLATFORM_SECRET).toBe("retained-secret");
    expect(platform[1].join(" ")).not.toContain("retained-secret");
    expect(h.run.mock.calls.filter(([c, a]) => c === "docker" && a[0] === "cp")).toHaveLength(2);
    const rename = h.run.mock.calls.findIndex(([c, a]) => c === "docker" && a[0] === "rename");
    const copies = h.run.mock.calls.flatMap(([c, a], i) => c === "docker" && a[0] === "cp" ? [i] : []);
    expect(rename).toBeGreaterThan(Math.max(...copies));
    expect(h.run.mock.calls.some(([c, a]) => c === "pnpm" && a.includes("esbuild"))).toBe(true);
    expect(h.run.mock.calls.some(([, a]) => a.includes("dev-production-parity-seed.ts") || a.includes("build-host-bundle.sh") || a.includes("build"))).toBe(false);
    expect(h.run.mock.calls.some(([c, a]) => c === "docker" && a[0] === "run" && a.includes("matrix-os-parity-router"))).toBe(true);
  });

  it("does not launch a duplicate QEMU when the matching VM is already running", async () => {
    const h = fixture({ liveVm: true }); await h.invoke();
    expect(h.run.mock.calls.some(([c]) => c === "qemu-system-x86_64")).toBe(false);
    expect(h.checkPort).not.toHaveBeenCalled();
  });

  it("restores removed dependency containers only onto retained volumes", async () => {
    const h = fixture({ missing: ["fixture-postgres-1", "fixture-minio-1"] }); await h.invoke();
    const calls = h.run.mock.calls;
    const start = calls.findIndex(([, a]) => a.includes("up"));
    expect(calls.slice(0, start).filter(([, a]) => a[0] === "volume")).toHaveLength(2);
    expect(calls[start][1]).toEqual(expect.arrayContaining(["--no-recreate", "--no-build", "--wait", "postgres", "minio"]));
  });

  it("rejects a different Docker context without changing it or starting the project", async () => {
    const h = fixture(); h.run.mockReturnValue("production");
    await expect(h.invoke()).rejects.toThrow(/local OrbStack/);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("refuses an occupied VM port before starting any containers", async () => {
    const h = fixture(); h.checkPort.mockRejectedValue(new Error("Port occupied"));
    await expect(h.invoke()).rejects.toThrow("Port occupied");
    expect(h.run.mock.calls.some(([, a]) => a.includes("up") || a[0] === "start")).toBe(false);
  });

  it("refuses foreign containers before starting or creating anything", async () => {
    const h = fixture({ foreign: "matrix-os-parity-router" });
    await expect(h.invoke()).rejects.toThrow(/another checkout/);
    expect(h.run.mock.calls.some(([c, a]) => c === "docker" && ["start", "create", "run"].includes(a[0]))).toBe(false);
  });

  it("refuses to fabricate a replacement for a deleted disk", async () => {
    const h = fixture(); rmSync(join(h.saved, "runtime/disk.qcow2"));
    await expect(h.invoke()).rejects.toThrow(/disk.qcow2/);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("fails before provisioning if the retained database volume is gone", async () => {
    const h = fixture(); const original = h.run.getMockImplementation()!;
    h.run.mockImplementation((c, a, o) => { if (c === "docker" && a[0] === "volume") throw new Error("Volume missing"); return original(c, a, o); });
    await expect(h.invoke()).rejects.toThrow(/volume/i);
    expect(h.run.mock.calls.some(([, a]) => a.includes("up") || a[0] === "start")).toBe(false);
  });

  it("removes only a newly created incomplete platform if restoring speech modules fails", async () => {
    const h = fixture({ missing: ["matrix-os-parity-platform"] }); const original = h.run.getMockImplementation()!;
    h.run.mockImplementation((c, a, o) => { if (c === "docker" && a[0] === "cp") throw new Error("Copy failed"); return original(c, a, o); });
    await expect(h.invoke()).rejects.toThrow("Copy failed");
    expect(h.run.mock.calls.filter(([c, a]) => c === "docker" && a[0] === "rm").map(([, a]) => a)).toEqual([["rm", "matrix-os-parity-platform-recovery"]]);
    expect(h.run.mock.calls.some(([, a]) => a[0] === "rename")).toBe(false);
  });

  it("recovers a killed platform reconstruction without reusing its incomplete container", async () => {
    const h = fixture({ missing: ["matrix-os-parity-platform"], interruptedCreate: true });
    await h.invoke();
    const removal = h.run.mock.calls.findIndex(([, a]) => a[0] === "rm");
    const create = h.run.mock.calls.findIndex(([, a]) => a[0] === "create");
    expect(removal).toBeGreaterThan(-1);
    expect(removal).toBeLessThan(create);
    expect(h.run.mock.calls[removal][1]).toEqual(["rm", "matrix-os-parity-platform-recovery"]);
  });

  it("bounds SSH boot waiting instead of claiming recovery", async () => {
    const h = fixture(); const original = h.run.getMockImplementation()!;
    h.run.mockImplementation((c, a, o) => { if (c === "ssh") throw new Error("Not ready"); return original(c, a, o); });
    await expect(h.invoke()).rejects.toThrow(/SSH/);
    expect(h.run.mock.calls.filter(([c]) => c === "ssh")).toHaveLength(60);
  });
});
