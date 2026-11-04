import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPreviewPairProfile, verifyPreviewPairProfile } from "@desktop/main/preview-pair-profiles";
import { verifiedPreviewPairTestContext } from "./preview-pair-test-context.js";
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "eng418-preview-home-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
describe("pair role profiles are owned, stable and separate from normal Electron state", () => {
  it("creates different owner/member userData and sessionData and preserves exact repeated launches", async () => {
    const owner = await verifiedPreviewPairTestContext(), member = await verifiedPreviewPairTestContext("member");
    const a = await createPreviewPairProfile(owner, home), b = await createPreviewPairProfile(member, home);
    expect(new Set([a.userData, a.sessionData, b.userData, b.sessionData]).size).toBe(4);
    await writeFile(join(a.userData, "existing-settings"), "preserve");
    expect(await createPreviewPairProfile(owner, home)).toEqual(a);
    expect(await verifyPreviewPairProfile(owner, a.userData, home)).toEqual(a);
    expect(await readFile(join(a.userData, "existing-settings"), "utf8")).toBe("preserve");
  });
  it("does not select an unowned normal profile even with a valid Source context", async () => {
    const context = await verifiedPreviewPairTestContext(), normal = join(home, "normal-electron");
    await mkdir(normal); await writeFile(join(normal, "credential.bin"), "normal-credential");
    await expect(verifyPreviewPairProfile(context, normal, home)).rejects.toThrow("unavailable");
    expect(await readdir(normal)).toEqual(["credential.bin"]);
  });
  it.each(["symlink", "unowned"])("refuses an existing %s role directory without writes outside its owned root", async fault => {
    const context = await verifiedPreviewPairTestContext();
    const generation = join(home, ".matrixos", "preview-pairs", context.pairId, `g${context.generation}`), normal = join(home, "normal");
    await mkdir(generation, { recursive: true, mode: 0o700 }); await mkdir(normal); await writeFile(join(normal, "keep"), "normal-state");
    if (fault === "symlink") await symlink(normal, join(generation, "owner")); else await mkdir(join(generation, "owner"), { mode: 0o700 });
    await expect(createPreviewPairProfile(context, home)).rejects.toThrow("unavailable");
    expect(await readdir(normal)).toEqual(["keep"]);
  });
  it("rejects a different immutable source instead of adopting or clearing the existing role", async () => {
    const context = await verifiedPreviewPairTestContext(), paths = await createPreviewPairProfile(context, home);
    await writeFile(join(paths.userData, "keep"), "old-reproduction");
    await expect(createPreviewPairProfile({ ...context, sourceSha: "b".repeat(40) }, home)).rejects.toThrow("unavailable");
    expect(await readFile(join(paths.userData, "keep"), "utf8")).toBe("old-reproduction");
  });
  it("reuses role directories across an authority epoch rotation so the auth service can retire only stale credentials", async () => {
    const context = await verifiedPreviewPairTestContext(), paths = await createPreviewPairProfile(context, home);
    expect(await createPreviewPairProfile({ ...context, authorityGeneration: context.authorityGeneration + 1 }, home)).toEqual(paths);
  });
});
