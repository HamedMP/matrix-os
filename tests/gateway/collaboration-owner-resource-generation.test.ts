import { mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnerResourceDriver } from "../../packages/gateway/src/collaboration/owner-resource-driver.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

// These regressions exercise actual descriptor-bound Linux generations.
describe.runIf(process.platform === "linux")("owner resource generations (Linux)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects stale bytes with deterministic equal stat identities and no retained fixture descriptor", async () => {
    const base = await mkdtemp(join(tmpdir(), "matrix-generation-collision-"));
    const path = join(base, "file");
    await writeFile(path, "original");
    const file = await open(path, "r");
    const prototype = Object.getPrototypeOf(file) as FileHandle;
    const originalStat = prototype.stat;
    await file.close();
    // Emulate the measured dev/ino/birthtime/ctime collision deterministically.
    // Actual native descriptors and filesystem generations remain unmodified.
    const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (this: FileHandle, options?: { bigint?: boolean }) {
      const info = await originalStat.call(this, options as { bigint: true });
      return Object.assign(info, { dev: 1n, ino: 1n, birthtimeNs: 1n, ctimeNs: 1n });
    });
    const driver = createOwnerResourceDriver({
      homePath: base,
      listOwnedProjectIds: async () => [],
      resolveProjectWorkingDirectory: async () => null,
      resolveAppAssetRoot: async () => null,
      resolveAppIncarnation: async () => null,
    });
    const namespace = { ownerId: "user_owner", projectId: null, path: "file" };
    try {
      const original = await driver.fingerprint(namespace);
      await rm(path); await writeFile(path, "replacement private bytes");
      const replacement = await driver.fingerprint(namespace);
      expect(replacement).not.toBe(original);
      await expect(driver.read({ ...namespace, expectedIncarnation: original })).rejects.toMatchObject({ code: "not_found" });
      const current = await driver.read({ ...namespace, expectedIncarnation: replacement });
      expect(await new Response(current.stream).text()).toBe("replacement private bytes");
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); driver.close(); await rm(base, { recursive: true, force: true }); }
  });

  it.each(["write", "writeChunks"] as const)("returns the exact written object identity despite replacement after %s publication", async (method) => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const base = await mkdtemp(join(tmpdir(), "matrix-generation-write-"));
    const namespace = { ownerId: "user_owner", projectId: null, path: "file" };
    const driver = createOwnerResourceDriver({
      homePath: base, listOwnedProjectIds: async () => [], resolveProjectWorkingDirectory: async () => null,
      resolveAppAssetRoot: async () => null, resolveAppIncarnation: async () => null,
    });
    const content = new TextEncoder().encode("the object actually written");
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      await actual.rename(from, to);
      await actual.rename(to, join(base, "captured"));
      await actual.writeFile(to, "unrelated replacement");
    });
    try {
      const incarnation = method === "write"
        ? await driver.write({ ...namespace, content })
        : await driver.writeChunks({ ...namespace, size: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
          chunks: (async function* () { yield content; })() });
      expect(incarnation).toBe(await driver.fingerprint({ ...namespace, path: "captured" }));
      expect(incarnation).not.toBe(await driver.fingerprint(namespace));
      await expect(driver.read({ ...namespace, expectedIncarnation: incarnation }))
        .rejects.toMatchObject({ code: "not_found" });
    } finally { driver.close(); await rm(base, { recursive: true, force: true }); }
  });
});
