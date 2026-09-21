/**
 * S07 / T035: sandbox policy boundary for shared runs and shared terminals.
 *
 * Pure checks run everywhere. Checks that need a real root systemd host
 * (unit launch, /proc visibility, credential reach, network denial) are
 * gated on COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1 and are reported as
 * explicitly unrun otherwise; they are never faked.
 */
import { chmod, lstat, mkdir, mkdtemp, link, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FORBIDDEN_SANDBOX_ENVIRONMENT,
  SANDBOX_WORKSPACE_MOUNT,
  SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST,
  SCOPE_RUNTIME_SANDBOX_POLICY_VERSION,
  assertSandboxEnvironment,
  buildSandboxSystemdProperties,
  validateSandboxMountSources,
} from "../../packages/scope-runtime/src/sandbox.js";
import {
  ScopeRuntimeRequestSchema,
  ScopeRuntimeSandboxManifestSchema,
} from "../../packages/scope-runtime/src/protocol.js";
import {
  SCOPE_RUNTIME_PROFILE,
  createScopeRuntimeController,
} from "../../packages/scope-runtime/src/supervisor.js";
import { buildFixedSystemdRunArgs } from "../../packages/scope-runtime/src/systemd-launcher.js";
import { SCOPE_RUNTIME_HARNESS_VERSION } from "../../packages/scope-runtime/src/profile.js";

const execFileAsync = promisify(execFile);
const HOST_PROBE = process.env.COLLABORATION_PROBE_SCOPE_RUNTIME_HOST === "1";
const unrun = (fixture: string) => `unrun: fixture ${fixture} missing`;
const SCOPE_HANDLE = "scope_11111111111111111111111111111111";
const RUNTIME_HANDLE = "runtime_22222222222222222222222222222222";
const FINGERPRINT = "a".repeat(64);
const cleanups: string[] = [];

afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});

async function worktree(): Promise<{ root: string; worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), "s07-sandbox-"));
  cleanups.push(root);
  const tree = join(root, "home", "projects", "launch-site");
  await mkdir(tree, { recursive: true, mode: 0o700 });
  await writeFile(join(tree, "README.md"), "# launch-site\n");
  return { root: join(root, "home"), worktree: tree };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    scopeHandle: SCOPE_HANDLE,
    actorId: "user_member",
    worktree: { hostPath: "/home/matrix/home/projects/launch-site", mode: "rw", fingerprint: FINGERPRINT },
    network: "none",
    ...overrides,
  };
}

describe("sandbox manifest", () => {
  it("accepts an actor/scope/worktree manifest and rejects unsafe shapes", () => {
    expect(ScopeRuntimeSandboxManifestSchema.parse(manifest())).toMatchObject({ network: "none" });
    for (const bad of [
      manifest({ worktree: { hostPath: "relative/path", mode: "rw", fingerprint: FINGERPRINT } }),
      manifest({ worktree: { hostPath: "/home/matrix/../root", mode: "rw", fingerprint: FINGERPRINT } }),
      manifest({ worktree: { hostPath: "/home/matrix/home\n", mode: "rw", fingerprint: FINGERPRINT } }),
      manifest({ worktree: { hostPath: "/home/matrix/home", mode: "exec", fingerprint: FINGERPRINT } }),
      manifest({ network: "host" }),
      manifest({ limits: { memoryMaxBytes: 2 * 1024 * 1024 * 1024, cpuQuotaPercent: 100, tasksMax: 64 } }),
      manifest({ limits: { memoryMaxBytes: 256 * 1024 * 1024, cpuQuotaPercent: 400, tasksMax: 64 } }),
      manifest({ environment: { GH_TOKEN: "x" } }),
      manifest({ extra: true }),
    ]) {
      expect(ScopeRuntimeSandboxManifestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is carried by runtime.create as an optional strict field", () => {
    const base = {
      version: 1,
      type: "runtime.create",
      requestId: "3d7a6a9b-5d3e-4a68-9c9f-1a2b3c4d5e6f",
      scopeHandle: SCOPE_HANDLE,
      profileId: "scope-runtime-chat-v1",
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
    };
    expect(ScopeRuntimeRequestSchema.safeParse(base).success).toBe(true);
    expect(ScopeRuntimeRequestSchema.safeParse({ ...base, sandbox: manifest() }).success).toBe(true);
    expect(ScopeRuntimeRequestSchema.safeParse({ ...base, sandbox: manifest({ network: "host" }) }).success).toBe(false);
  });
});

describe("sandbox systemd policy", () => {
  it("binds only the worktree, denies every network and never widens the fixed profile", () => {
    const properties = buildSandboxSystemdProperties(
      ScopeRuntimeSandboxManifestSchema.parse(manifest()),
      { worktreeHostPath: "/home/matrix/home/projects/launch-site" },
    );
    expect(properties).toContain(`BindPaths=/home/matrix/home/projects/launch-site:${SANDBOX_WORKSPACE_MOUNT}`);
    expect(properties).toContain("IPAddressDeny=any");
    expect(properties).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(properties).toContain("PrivateNetwork=yes");
    expect(properties.some((entry) => entry.startsWith("InaccessiblePaths=-/opt/matrix/env"))).toBe(true);
    expect(properties.some((entry) => entry.startsWith("UnsetEnvironment="))).toBe(true);
    expect(properties.some((entry) => /^(MemoryMax|CPUQuota|TasksMax)=/.test(entry))).toBe(false);
    const readOnly = buildSandboxSystemdProperties(
      ScopeRuntimeSandboxManifestSchema.parse(manifest({
        worktree: { hostPath: "/home/matrix/home/projects/launch-site", mode: "ro", fingerprint: FINGERPRINT },
        network: "broker_only",
        limits: { memoryMaxBytes: 256 * 1024 * 1024, cpuQuotaPercent: 50, tasksMax: 32 },
      })),
      { worktreeHostPath: "/home/matrix/home/projects/launch-site" },
    );
    expect(readOnly).toContain(`BindReadOnlyPaths=/home/matrix/home/projects/launch-site:${SANDBOX_WORKSPACE_MOUNT}`);
    expect(readOnly).toContain("MemoryMax=268435456");
    expect(readOnly).toContain("CPUQuota=50%");
    expect(readOnly).toContain("TasksMax=32");
    expect(readOnly).toContain("IPAddressDeny=any");
  });

  it("pins the policy digest to the property template and forbidden environment", () => {
    expect(SCOPE_RUNTIME_SANDBOX_POLICY_VERSION).toBe(1);
    expect(SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(FORBIDDEN_SANDBOX_ENVIRONMENT).toEqual(expect.arrayContaining([
      "GH_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "SSH_AUTH_SOCK", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
    ]));
    expect(() => assertSandboxEnvironment(["HOME=/workspace", "MATRIX_SCOPE_RUNTIME=1"])).not.toThrow();
    expect(() => assertSandboxEnvironment(["HOME=/workspace", "GH_TOKEN=ghp_x"])).toThrow(/environment/i);
    expect(() => assertSandboxEnvironment(["GIT_CONFIG_GLOBAL=/home/matrix/.gitconfig"])).toThrow(/environment/i);
  });

  it("advertises the sandbox policy in the fixed capability profile", () => {
    expect(SCOPE_RUNTIME_PROFILE.sandbox).toEqual({
      policyVersion: SCOPE_RUNTIME_SANDBOX_POLICY_VERSION,
      policyDigest: SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST,
      workloads: ["chat_ai", "terminal"],
    });
  });
});

describe("mount source validation", () => {
  it("accepts a real directory under an allowed root", async () => {
    const { root, worktree: tree } = await worktree();
    await expect(validateSandboxMountSources(
      ScopeRuntimeSandboxManifestSchema.parse(manifest({ worktree: { hostPath: tree, mode: "rw", fingerprint: FINGERPRINT } })),
      { allowedRoots: [root] },
    )).resolves.toEqual({ worktreeHostPath: tree });
  });

  it("rejects symlinked worktrees, symlinked components, files, hardlinked entries and paths outside the allowed roots", async () => {
    const { root, worktree: tree } = await worktree();
    const outside = await mkdtemp(join(tmpdir(), "s07-outside-"));
    cleanups.push(outside);
    await writeFile(join(outside, "secret"), "token\n");
    const linkedTree = join(root, "projects", "linked");
    await symlink(outside, linkedTree);
    const linkedComponent = join(root, "projects", "via-link", "launch-site");
    await symlink(outside, join(root, "projects", "via-link"));
    const file = join(tree, "README.md");
    const hardlinked = join(root, "projects", "hard");
    await mkdir(hardlinked, { recursive: true });
    await link(join(outside, "secret"), join(hardlinked, "secret"));
    for (const [hostPath, roots, reason] of [
      [linkedTree, [root], "symlinked worktree"],
      [linkedComponent, [root], "symlinked component"],
      [file, [root], "file"],
      [tree, [outside], "outside allowed roots"],
      [hardlinked, [root], "hardlinked entry"],
    ] as const) {
      await expect(validateSandboxMountSources(
        ScopeRuntimeSandboxManifestSchema.parse(manifest({ worktree: { hostPath, mode: "rw", fingerprint: FINGERPRINT } })),
        { allowedRoots: [...roots] },
      ), reason).rejects.toThrow();
    }
  });

  it("rejects a world-writable worktree parent that could be swapped under the mount", async () => {
    const { root, worktree: tree } = await worktree();
    await chmod(join(root, "projects"), 0o777);
    await expect(validateSandboxMountSources(
      ScopeRuntimeSandboxManifestSchema.parse(manifest({ worktree: { hostPath: tree, mode: "rw", fingerprint: FINGERPRINT } })),
      { allowedRoots: [root] },
    )).rejects.toThrow();
    const entry = await lstat(join(root, "projects"));
    expect(entry.mode & 0o002).toBe(0o002);
  });
});

describe("supervisor and launcher", () => {
  it("passes the manifest to the launcher and keeps unsandboxed terminals unavailable", async () => {
    const start = vi.fn(async () => {});
    const controller = await createScopeRuntimeController({
      executionGeneration: "9",
      launcher: {
        supportedAdapters: async () => [
          { adapterId: "claude-code", harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION, workloads: ["chat_ai"] },
          { adapterId: "terminal", harnessVersion: "1.0.0", workloads: ["terminal"] },
        ],
        list: async () => [],
        start,
        runChat: async () => ({ text: "" }),
        stop: async () => {},
      },
      createRuntimeHandle: () => RUNTIME_HANDLE,
    });
    const base = {
      version: 1 as const,
      type: "runtime.create" as const,
      requestId: "3d7a6a9b-5d3e-4a68-9c9f-1a2b3c4d5e6f",
      scopeHandle: SCOPE_HANDLE,
      profileId: "scope-runtime-chat-v1",
      workload: "chat_ai" as const,
      adapterId: "claude-code",
      harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
    };
    await expect(controller.handle({ ...base, sandbox: manifest() as never })).resolves.toMatchObject({ ok: true, state: "running" });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sandbox: expect.objectContaining({ actorId: "user_member" }) }));
    await expect(controller.handle({
      ...base, requestId: "3d7a6a9b-5d3e-4a68-9c9f-1a2b3c4d5e70", workload: "terminal", adapterId: "terminal", harnessVersion: "1.0.0",
    })).resolves.toMatchObject({ ok: false, error: "invalid_request" });
    const capability = await controller.handle({ version: 1, type: "capability.get", requestId: "3d7a6a9b-5d3e-4a68-9c9f-1a2b3c4d5e71" });
    expect(capability).toMatchObject({ ok: true, profile: { sandbox: { policyDigest: SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST } } });
    await controller.close();
  });

  it("appends the sandbox properties after the fixed profile without changing the fixed arguments", () => {
    const paths = {
      scopeRoot: "/var/lib/matrix-scope/runtimes/x/root",
      sdkDirectory: "/opt/matrix/scope-sdk/sdk",
      nativeDirectory: "/opt/matrix/scope-sdk/native",
      workerFile: "/opt/matrix/scope-runtime/worker.mjs",
      brokerSocket: "/run/matrix-scope/broker.sock",
      readinessFile: "/var/lib/matrix-scope/runtimes/x/ready",
      commandDirectory: "/var/lib/matrix-scope/runtimes/x/command",
      nodeBinary: "/opt/matrix/runtime/node/bin/node",
    };
    const launch = {
      runtimeHandle: RUNTIME_HANDLE,
      scopeHandle: SCOPE_HANDLE,
      workload: "chat_ai" as const,
      adapterId: "claude-code",
      harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
      executionGeneration: "9",
    };
    const fixed = buildFixedSystemdRunArgs(launch, paths);
    const sandboxed = buildFixedSystemdRunArgs(launch, paths, {
      sandboxProperties: buildSandboxSystemdProperties(
        ScopeRuntimeSandboxManifestSchema.parse(manifest()),
        { worktreeHostPath: "/home/matrix/home/projects/launch-site" },
      ),
    });
    const fixedSeparator = fixed.indexOf("--");
    const sandboxedSeparator = sandboxed.indexOf("--");
    expect(sandboxed.slice(sandboxedSeparator)).toEqual(fixed.slice(fixedSeparator));
    expect(sandboxed.slice(0, sandboxedSeparator)).toEqual(expect.arrayContaining(fixed.slice(0, fixedSeparator)));
    expect(sandboxed).toContain(`--property=BindPaths=/home/matrix/home/projects/launch-site:${SANDBOX_WORKSPACE_MOUNT}`);
    expect(sandboxed).toContain("--property=IPAddressDeny=any");
    expect(sandboxed.filter((entry) => entry.startsWith("--setenv="))).toEqual(fixed.filter((entry) => entry.startsWith("--setenv=")));
  });
});

describe("host boundary probes (root systemd host)", () => {
  const skip = !HOST_PROBE;
  async function run(properties: string[], command: string[]): Promise<{ code: number; stdout: string }> {
    try {
      const result = await execFileAsync("/usr/bin/systemd-run", [
        "--quiet", "--wait", "--pipe", "--collect",
        ...properties.map((property) => `--property=${property}`),
        "--", ...command,
      ], { timeout: 30_000, maxBuffer: 64 * 1024 });
      return { code: 0, stdout: result.stdout };
    } catch (error: unknown) {
      const failure = error as { code?: number | string; stdout?: string };
      return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "" };
    }
  }
  const properties = () => buildSandboxSystemdProperties(
    ScopeRuntimeSandboxManifestSchema.parse(manifest({ worktree: { hostPath: "/tmp", mode: "ro", fingerprint: FINGERPRINT } })),
    { worktreeHostPath: "/tmp" },
  );

  it.skipIf(skip)(`owner credential files are unreachable from a sandboxed process (${unrun("COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1")})`, async () => {
    for (const path of ["/home/matrix/.gitconfig", "/home/matrix/.config/gh/hosts.yml", "/opt/matrix/env/host.env", "/root/.ssh"]) {
      const result = await run(["ProtectHome=yes", "ProtectSystem=strict", ...properties()], ["/bin/cat", path]);
      expect(result.code, path).not.toBe(0);
    }
  });

  it.skipIf(skip)(`network is denied and other processes are invisible (${unrun("COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1")})`, async () => {
    const network = await run(["ProtectHome=yes", ...properties()], ["/bin/sh", "-c", "exec 3<>/dev/tcp/1.1.1.1/443"]);
    expect(network.code).not.toBe(0);
    const proc = await run(["ProtectProc=invisible", "ProcSubset=pid", ...properties()], ["/bin/sh", "-c", "ls /proc | grep -E '^[0-9]+$' | wc -l"]);
    expect(Number(proc.stdout.trim())).toBeLessThanOrEqual(2);
  });

  it.skipIf(skip)(`a git credential helper cannot be reached from the sandbox (${unrun("COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1")})`, async () => {
    const result = await run(["ProtectHome=yes", ...properties()], [
      "/bin/sh", "-c", "git config --global credential.helper || GIT_TERMINAL_PROMPT=0 git credential fill </dev/null",
    ]);
    expect(result.stdout.trim()).toBe("");
  });
});
