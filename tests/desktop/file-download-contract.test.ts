import { describe, expect, it } from "vitest";
import { FileDownloadRequestSchema, FileDownloadResultSchema, safeDownloadFilename } from "../../packages/contracts/src/file-download";

const base = { requestId: "1a745da3-7551-434e-8947-634928188816", runtimeSlot: "primary", authGeneration: 0 };
describe("file download boundary", () => {
  it.each(["../secret", "/absolute", "a/../b", "a//b", "a\\b", "a\u0000b", "./a", " a "])("rejects unsafe path %s", (path) => {
    expect(FileDownloadRequestSchema.safeParse({ ...base, path }).success).toBe(false);
  });
  it("keeps Unicode and URL-reserved characters in a valid owner-relative path", () => {
    const path = "projects/文件 #1&2.zip";
    expect(FileDownloadRequestSchema.parse({ ...base, path }).path).toBe(path);
  });
  it("rejects extra native destination/credential fields", () => {
    expect(FileDownloadRequestSchema.safeParse({ ...base, path: "a.zip", destination: "/private/a.zip" }).success).toBe(false);
    expect(FileDownloadResultSchema.safeParse({ status: "saved", path: "/private/a.zip" }).success).toBe(false);
    expect(FileDownloadResultSchema.safeParse({ status: "error", code: "EACCES /private" }).success).toBe(false);
  });
  it.each([["CON.txt", "_CON.txt"], ["report:1?.zip", "report_1_.zip"], ["报告.zip", "报告.zip"]])("makes %s a portable local basename", (name, expected) => {
    expect(safeDownloadFilename(name)).toBe(expected);
  });
  it("bounds long Unicode filenames in bytes", () => {
    expect(new TextEncoder().encode(safeDownloadFilename("报".repeat(200) + ".zip")).length).toBeLessThanOrEqual(240);
    expect(safeDownloadFilename("报".repeat(200) + ".zip")).toMatch(/\.zip$/);
  });
});
