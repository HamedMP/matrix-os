import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVerificationSource } from "@desktop/main/chat-electron-preview/verification-setup";

let sandbox: string | undefined;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

async function fixture() {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "matrix-verification-source-")));
  const checkout = join(sandbox, "checkout");
  const electronPackage = join(sandbox, "pnpm", "electron");
  const electron = join(electronPackage, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  const packageJson = join(checkout, "desktop", "package.json");
  // Explicit modes keep the fixture a default 022 checkout on umask 002 hosts.
  await mkdir(join(checkout, "desktop", "node_modules"), { recursive: true, mode: 0o755 });
  await mkdir(dirname(electron), { recursive: true });
  await mkdir(join(checkout, ".git"));
  await writeFile(join(checkout, "package.json"), '{"name":"matrix-os"}');
  await writeFile(packageJson, '{"name":"desktop"}');
  await writeFile(join(electronPackage, "index.js"), 'throw new Error("must never execute");');
  await writeFile(electron, "Fixture executable", { mode: 0o700 });
  await symlink(electronPackage, join(checkout, "desktop", "node_modules", "electron"), "dir");
  return { checkout, electron, packageJson };
}

describe("packaged Mac Verification dependencies", () => {
  it("resolves the pinned checkout's pnpm-linked Electron without executing package code", async () => {
    const { checkout, electron } = await fixture();
    expect(await resolveVerificationSource(checkout)).toMatchObject({ checkout, electronPath: electron });
    const before = await resolveVerificationSource(checkout);
    await writeFile(electron, "Updated executable");
    expect((await resolveVerificationSource(checkout))?.identity).not.toBe(before?.identity);
  });

  it("rejects another project, a symlink manifest and a group-writable Electron executable", async () => {
    const { checkout, electron, packageJson } = await fixture();
    await writeFile(packageJson, '{"name":"other"}');
    expect(await resolveVerificationSource(checkout)).toBeNull();
    await rm(packageJson);
    await writeFile(join(sandbox!, "package.json"), '{"name":"desktop"}');
    await symlink(join(sandbox!, "package.json"), packageJson);
    expect(await resolveVerificationSource(checkout)).toBeNull();
    await rm(packageJson);
    await writeFile(packageJson, '{"name":"desktop"}');
    await chmod(electron, 0o720);
    expect(await resolveVerificationSource(checkout)).toBeNull();
  });

  it("rejects a group-writable checkout even when its pnpm-linked Electron is safe", async () => {
    const { checkout, electron } = await fixture();
    expect(await resolveVerificationSource(checkout)).toMatchObject({ checkout, electronPath: electron });
    await chmod(checkout, 0o775);
    expect(await resolveVerificationSource(checkout)).toBeNull();
  });
});
