import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTerminalCapacityAdmission, terminalTasksUnderPressure } from "../../packages/gateway/src/shell/terminal-runtime-capacity.js";

describe("terminal runtime capacity admission", () => {
  it("uses aggregate task pressure rather than process age to shorten the idle grace", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-pressure-"));
    try {
      await writeFile(join(root, "pids.max"), "4096");
      await writeFile(join(root, "pids.current"), "3837");
      expect(await terminalTasksUnderPressure(root)).toBe(true);
      await writeFile(join(root, "pids.current"), "1071");
      expect(await terminalTasksUnderPressure(root)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("preserves existing active units at capacity and supports the first aggregate launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-capacity-"));
    const admission = createTerminalCapacityAdmission({ root });
    try {
      await expect(admission("rt_first")).resolves.toBeUndefined();
      await writeFile(join(root, "pids.max"), "4096\n");
      await writeFile(join(root, "pids.current"), "4096\n");
      const unit = join(root, "matrix-zellij@rt_existing.service");
      await mkdir(unit);
      await writeFile(join(unit, "pids.current"), "81\n");
      await expect(admission("rt_existing")).resolves.toBeUndefined();
      expect(await readFile(join(unit, "pids.current"), "utf8")).toBe("81\n");
      expect(await readFile(join(root, "pids.max"), "utf8")).toBe("4096\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["", "garbage", "-1", "9007199254740992"])("fails closed on invalid capacity: %s", async (value) => {
    const root = await mkdtemp(join(tmpdir(), "terminal-capacity-"));
    try {
      await writeFile(join(root, "pids.max"), value);
      await writeFile(join(root, "pids.current"), "0");
      await expect(createTerminalCapacityAdmission({ root })("rt_first")).rejects.toThrow("Terminal runtime capacity unavailable");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects exhausted and burst launches without deleting existing runtimes", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-capacity-"));
    let now = 0;
    const admission = createTerminalCapacityAdmission({ root, now: () => now });
    try {
      await writeFile(join(root, "pids.max"), "4096\n");
      await writeFile(join(root, "pids.current"), "4075\n");
      await expect(admission("rt_first")).rejects.toThrow("Terminal runtime capacity unavailable");
      await writeFile(join(root, "pids.current"), "3900\n");
      await expect(admission("rt_first")).resolves.toBeUndefined();
      await expect(admission("rt_second")).rejects.toThrow("Terminal runtime capacity unavailable");
      now = 31_000;
      await expect(admission("rt_second")).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
