import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readAppCapabilityGrant } from "../../../packages/gateway/src/app-capabilities/policy";
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "app-policy-")); await mkdir(join(home, "system")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
it("fails closed for symlinked owner policy", async () => {
  const target = join(home, "outside.json");
  await writeFile(target, JSON.stringify({ apps: { "drive-chat": { services: { google_drive: ["read_file"] } } } }));
  await symlink(target, join(home, "system/app-capabilities.json"));
  await expect(readAppCapabilityGrant(home, "drive-chat")).rejects.toThrow();
});
it("denies absent policy but rejects oversized or malformed owner policy", async () => {
  expect(await readAppCapabilityGrant(home, "drive-chat")).toBeNull();
  await writeFile(join(home, "system/app-capabilities.json"), " ".repeat(65_537));
  await expect(readAppCapabilityGrant(home, "drive-chat")).rejects.toThrow();
  await writeFile(join(home, "system/app-capabilities.json"), "{}");
  await expect(readAppCapabilityGrant(home, "drive-chat")).rejects.toThrow();
});
