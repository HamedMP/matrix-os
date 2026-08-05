import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrUpdateDevInstance,
  deriveDevInstanceName,
  loadDevInstances,
  normalizeDevInstanceName,
} from "../../src/cli/dev-workspaces.js";
import { devCommand } from "../../src/cli/commands/dev.js";

const roots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function createRepo(name = "matrix-os-src"): Promise<string> {
  const repo = join(await tempDir("matrix-dev-repo-"), name);
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "matrix-os" }));
  await writeFile(join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(join(repo, "docker-compose.dev-vps.yml"), "services: {}\n");
  return repo;
}

function captureLogs() {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    logs.push(String(line));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  return logs;
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dev workspace helpers", () => {
  it("validates explicit dev instance names", () => {
    expect(normalizeDevInstanceName("main-1")).toBe("main-1");
    expect(() => normalizeDevInstanceName("Main")).toThrow("Dev instance names");
    expect(() => normalizeDevInstanceName("../main")).toThrow("Dev instance names");
  });

  it("derives a safe default name from a repo path", () => {
    expect(deriveDevInstanceName("/tmp/Matrix OS Src")).toBe("matrix-os-src");
  });

  it("writes owner-local metadata and env files", async () => {
    const home = await tempDir("matrix-dev-home-");
    const repo = await createRepo();

    const instance = await createOrUpdateDevInstance({
      homeDir: home,
      repoPath: repo,
      name: "main",
      isPortFree: async () => true,
      now: () => new Date("2026-07-02T00:00:00.000Z"),
    });

    expect(instance).toMatchObject({
      name: "main",
      projectName: "matrix-dev-main",
      shellPort: 3100,
      gatewayPort: 4100,
      exposure: "local",
    });
    const env = await readFile(instance.envPath, "utf8");
    expect(env).toContain("MATRIX_DEV_EXPOSURE=local");
    expect(env).toContain("MATRIX_DEV_SHELL_PORT=3100");
    expect(env).toContain("MATRIX_DEV_GATEWAY_PORT=4100");
    expect(env).toContain("MATRIX_DEV_GATEWAY_URL=http://127.0.0.1:4100");
    expect(env).toContain("DEV_VPS_POSTGRES_DB=matrixos_main");
    expect(await loadDevInstances(home)).toHaveLength(1);
  });

  it("allocates the next port pair and reuses ports for an existing instance", async () => {
    const home = await tempDir("matrix-dev-home-");
    const repo = await createRepo();
    const calls: number[] = [];
    const isPortFree = vi.fn(async (port: number) => {
      calls.push(port);
      return port !== 3100 && port !== 4100;
    });

    const first = await createOrUpdateDevInstance({ homeDir: home, repoPath: repo, name: "main", isPortFree });
    const second = await createOrUpdateDevInstance({ homeDir: home, repoPath: repo, name: "main", isPortFree });

    expect(first.shellPort).toBe(3101);
    expect(first.gatewayPort).toBe(4101);
    expect(second.shellPort).toBe(3101);
    expect(second.gatewayPort).toBe(4101);
    expect(calls).toEqual([3100, 3101, 4101]);
  });

  it("rejects directories that are not Matrix OS checkouts", async () => {
    const home = await tempDir("matrix-dev-home-");
    const repo = await tempDir("not-matrix-");

    await expect(createOrUpdateDevInstance({ homeDir: home, repoPath: repo })).rejects.toMatchObject({
      code: "invalid_dev_repo",
    });
  });
});

describe("mos dev command", () => {
  it("starts compose with generated env and project name", async () => {
    const home = await tempDir("matrix-dev-home-");
    const repo = await createRepo();
    const logs = captureLogs();
    const commandRunner = vi.fn(async () => {});

    await devCommand.subCommands!.up.run!({
      args: { home, path: repo, name: "main", json: true, commandRunner },
    } as never);

    expect(commandRunner).toHaveBeenCalledTimes(1);
    const [command, args, options] = commandRunner.mock.calls[0]!;
    expect(command).toBe("docker");
    expect(args).toContain("compose");
    expect(args).toContain("--env-file");
    expect(args).toContain("-p");
    expect(args).toContain("matrix-dev-main");
    expect(args.slice(-2)).toEqual(["up", "-d"]);
    expect(options).toMatchObject({ cwd: repo, stdio: "inherit" });
    const parsed = JSON.parse(logs[0]!);
    expect(parsed).toMatchObject({
      ok: true,
      data: { name: "main", shellUrl: "http://127.0.0.1:3100", gatewayUrl: "http://127.0.0.1:4100" },
    });
  });

  it("keeps public preview commands as stretch-goal placeholders", async () => {
    captureLogs();

    await devCommand.subCommands!.expose.run!({ args: { name: "main", json: true } } as never);

    expect(process.exitCode).toBe(1);
    const err = JSON.parse((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!);
    expect(err.error).toMatchObject({ code: "not_implemented" });
  });
});
