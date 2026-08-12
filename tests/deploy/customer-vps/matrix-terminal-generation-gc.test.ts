import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const generation = (character: string) => `gen_${character.repeat(64)}`;

describe("terminal runtime generation GC candidates", () => {
  let fixtureRoot: string;
  let runtimeRoot: string;
  let descriptorRoot: string;
  let appDir: string;
  let rollbackDir: string;
  const script = join(process.cwd(), "distro/customer-vps/host-bin/matrix-terminal-generation-gc.py");

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "matrix-terminal-generation-gc-"));
    runtimeRoot = join(fixtureRoot, "runtime");
    descriptorRoot = join(fixtureRoot, "descriptors");
    appDir = join(fixtureRoot, "app");
    rollbackDir = join(fixtureRoot, "rollback");
    await Promise.all([
      mkdir(join(runtimeRoot, "generations"), { recursive: true }),
      mkdir(descriptorRoot),
      mkdir(appDir),
      mkdir(rollbackDir),
    ]);
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("keeps current, rollback, and descriptor-referenced generations while pruning oldest unreferenced ones", async () => {
    const names = [generation("1"), generation("2"), generation("3"), generation("4")];
    for (let index = 0; index < names.length; index += 1) {
      const path = join(runtimeRoot, "generations", names[index]!);
      await mkdir(path);
      await utimes(path, index + 1, index + 1);
    }
    await symlink(join("generations", names[3]!), join(runtimeRoot, "current"));
    await writeFile(join(rollbackDir, "TERMINAL_RUNTIME_GENERATION"), `${names[0]}\n`);
    await writeFile(join(descriptorRoot, "runtime.json"), JSON.stringify({ generation: names[0] }));

    const { stdout } = await execFileAsync("python3", [
      script,
      runtimeRoot,
      descriptorRoot,
      appDir,
      rollbackDir,
      "2",
    ]);

    expect(stdout.trim().split("\n")).toEqual([names[1], names[2]]);
  });

  it("ignores corrupt descriptors and symlink generation entries", async () => {
    const first = generation("a");
    const second = generation("b");
    const third = generation("c");
    await mkdir(join(runtimeRoot, "generations", first));
    await mkdir(join(runtimeRoot, "generations", second));
    await symlink(join(runtimeRoot, "generations", second), join(runtimeRoot, "generations", third));
    await writeFile(join(descriptorRoot, "corrupt.json"), "not-json");

    const { stdout } = await execFileAsync("python3", [
      script,
      runtimeRoot,
      descriptorRoot,
      appDir,
      rollbackDir,
      "2",
    ]);

    expect(stdout).toBe("");
  });

  it("holds one symlink-safe lock across the descriptor scan and deletion", async () => {
    const names = [generation("1"), generation("2"), generation("3")];
    for (let index = 0; index < names.length; index += 1) {
      const path = join(runtimeRoot, "generations", names[index]!);
      await mkdir(path);
      await utimes(path, index + 1, index + 1);
    }

    const holder = spawn("python3", [script, "--lock", descriptorRoot], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout.once("data", (chunk) => {
        if (chunk.toString() === "locked\n") resolve();
        else reject(new Error("generation lock holder did not become ready"));
      });
    });

    const deleting = execFileAsync("python3", [
      script,
      "--delete",
      runtimeRoot,
      descriptorRoot,
      appDir,
      rollbackDir,
      "2",
    ]);
    await writeFile(join(descriptorRoot, "runtime.json"), JSON.stringify({ generation: names[0] }));
    holder.stdin.end();
    await new Promise<void>((resolve, reject) => {
      holder.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`)));
    });
    const { stdout } = await deleting;

    expect(stdout.trim()).toBe(names[1]);
    await expect(execFileAsync("test", ["-d", join(runtimeRoot, "generations", names[0])])).resolves.toBeDefined();
    await expect(execFileAsync("test", ["-d", join(runtimeRoot, "generations", names[1])])).rejects.toBeDefined();
  });

  it("creates a missing descriptor root before first-install garbage collection", async () => {
    const names = [generation("1"), generation("2"), generation("3")];
    for (let index = 0; index < names.length; index += 1) {
      const path = join(runtimeRoot, "generations", names[index]!);
      await mkdir(path);
      await utimes(path, index + 1, index + 1);
    }
    await rm(descriptorRoot, { recursive: true });

    const { stdout } = await execFileAsync("python3", [
      script,
      "--delete",
      runtimeRoot,
      descriptorRoot,
      appDir,
      rollbackDir,
      "2",
    ]);

    expect(stdout.trim()).toBe(names[0]);
    await expect(execFileAsync("test", ["-d", descriptorRoot])).resolves.toBeDefined();
    await expect(execFileAsync("test", ["-f", join(descriptorRoot, ".generation-gc.lock")])).resolves.toBeDefined();
  });

  it("does not create a descriptor root through a symlinked parent", async () => {
    const outside = join(fixtureRoot, "outside");
    const linkedParent = join(fixtureRoot, "linked-parent");
    const linkedDescriptorRoot = join(linkedParent, "descriptors");
    await mkdir(outside);
    await symlink(outside, linkedParent);

    await expect(execFileAsync("python3", [
      script,
      "--delete",
      runtimeRoot,
      linkedDescriptorRoot,
      appDir,
      rollbackDir,
      "2",
    ])).rejects.toBeDefined();
    await expect(execFileAsync("test", ["-e", join(outside, "descriptors")])).rejects.toBeDefined();
  });

  it("fails closed when the shared lock entry is a symlink", async () => {
    const first = generation("a");
    const second = generation("b");
    const third = generation("c");
    await mkdir(join(runtimeRoot, "generations", first));
    await mkdir(join(runtimeRoot, "generations", second));
    await mkdir(join(runtimeRoot, "generations", third));
    await symlink(join(fixtureRoot, "outside-lock"), join(descriptorRoot, ".generation-gc.lock"));

    await expect(execFileAsync("python3", [
      script,
      "--delete",
      runtimeRoot,
      descriptorRoot,
      appDir,
      rollbackDir,
      "2",
    ])).rejects.toBeDefined();
    await expect(execFileAsync("test", ["-d", join(runtimeRoot, "generations", first)])).resolves.toBeDefined();
  });
});
