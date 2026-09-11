import { appendCreatedFileEntry } from "@/lib/queries/file-directory-cache";

describe("file directory cache", () => {
  it("adds a created folder to the current directory", () => {
    expect(appendCreatedFileEntry(
      { path: "", entries: [{ name: "README.md", type: "file", gitStatus: null }] },
      "Projects",
      "directory",
    )).toEqual({
      path: "",
      entries: [
        { name: "README.md", type: "file", gitStatus: null },
        { name: "Projects", type: "directory", gitStatus: null },
      ],
    });
  });

  it("does not duplicate an entry already present in the cache", () => {
    const current = {
      path: "",
      entries: [{ name: "Projects", type: "directory" as const, gitStatus: null }],
    };

    expect(appendCreatedFileEntry(current, "Projects", "directory")).toBe(current);
  });
});
