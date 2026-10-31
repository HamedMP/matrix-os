import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TerminalHostDescriptorSchema, readTerminalHostDescriptor } from "../../../packages/gateway/src/terminal/host-descriptor.js";
const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });
const descriptor = { version: 1, kind: "terminal-native", launchId: "a".repeat(32), generation: "gen_" + "b".repeat(64), createdAt: "2026-11-01T00:00:00.000Z", directory: "/run/user/1000/matrix-terminal-" + "a".repeat(32),
  launch: { command: "/bin/sh", args: [], cwd: "/tmp", env: { PATH: "/usr/bin:/bin", HOME: "/tmp", TERM: "xterm-256color" }, inheritEnv: false }, cols: 80, rows: 24 };
it("persists only public launch/I/O metadata, never owner authority or mutable module controls", () => {
  expect(TerminalHostDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  for (const value of [{ ...descriptor, ownerId: "owner" }, { ...descriptor, source: "bearer" }, { ...descriptor, launch: { ...descriptor.launch, env: { NODE_OPTIONS: "--import /opt/matrix/app/a.mjs" } } },
    { ...descriptor, launch: { ...descriptor.launch, env: { MATRIX_TERMINAL_ROUTINE_SOCKET: "/attacker/routine.sock" } } }, { ...descriptor, directory: "/tmp/other" }]) expect(TerminalHostDescriptorSchema.safeParse(value).success).toBe(false);
});
it("rejects changed digest, symlink and oversized startup files", async () => {
  const root = await mkdtemp("/tmp/t7desc-"); cleanups.push(root); const path = join(root, "launch.json");
  await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
  const valid = await readTerminalHostDescriptor(path); expect(valid.descriptor).toEqual(descriptor);
  await expect(readTerminalHostDescriptor(path, "c".repeat(64))).rejects.toThrow();
  await symlink(path, join(root, "link")); await expect(readTerminalHostDescriptor(join(root, "link"))).rejects.toThrow();
  await writeFile(path, "x".repeat(65537)); await expect(readTerminalHostDescriptor(path)).rejects.toThrow();
});
