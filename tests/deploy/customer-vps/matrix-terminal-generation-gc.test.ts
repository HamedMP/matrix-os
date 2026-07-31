import { execFile } from "node:child_process";
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
});
