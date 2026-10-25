import { expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import { createDirectoryArchive } from "@desktop/renderer/src/features/files/directory-download";
it("downloads a folder as a ZIP with nested files and empty folders", async () => {
  const list = vi.fn(async (path: string) => path === "notes" ? [{ path: "notes/readme.md", kind: "file" as const }, { path: "notes/empty", kind: "directory" as const }] : []);
  const read = vi.fn(async () => new Uint8Array([65, 66]));
  const result = await createDirectoryArchive("notes", { list, read }, new AbortController().signal);
  const zip = unzipSync(result.bytes);
  expect(result.name).toBe("notes.zip");
  expect(zip["notes/readme.md"]).toEqual(new Uint8Array([65, 66]));
  expect(zip["notes/empty/"]).toBeDefined();
});
it("rejects escaping, duplicate and unsupported entries without reading them", async () => {
  for (const entries of [[{ path: "elsewhere/secret", kind: "file" }], [{ path: "notes/../secret", kind: "file" }], [{ path: "notes/link", kind: "symlink" }]]) {
    const read = vi.fn();
    await expect(createDirectoryArchive("notes", { list: async () => entries as never, read }, new AbortController().signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  }
});
it("enforces a shared archive byte limit and cancellation", async () => {
  const read = vi.fn(async () => new Uint8Array(51 * 1024 * 1024));
  await expect(createDirectoryArchive("notes", { list: async () => [{ path: "notes/large", kind: "file" }], read }, new AbortController().signal)).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(createDirectoryArchive("notes", { list: vi.fn(), read: vi.fn() }, controller.signal)).rejects.toThrow();
});
it("cancels a pending directory read even when its transport ignores abort", async () => {
  const controller = new AbortController();
  const pending = createDirectoryArchive("notes", { list: () => new Promise(() => {}), read: vi.fn() }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
});
