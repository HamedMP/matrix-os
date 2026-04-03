import { describe, it, expect } from "vitest";
import { detectUrls, detectFilePaths } from "../../shell/src/components/terminal/web-link-provider.js";

describe("Web Link Provider", () => {
  describe("URL detection", () => {
    it("detects http URLs", () => {
      const matches = detectUrls("Visit http://example.com for details");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.text).toBe("http://example.com");
    });

    it("detects https URLs", () => {
      const matches = detectUrls("See https://github.com/user/repo");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.text).toBe("https://github.com/user/repo");
    });

    it("detects multiple URLs in one line", () => {
      const matches = detectUrls("Links: https://a.com and https://b.com/path");
      expect(matches).toHaveLength(2);
    });

    it("strips trailing punctuation from URLs", () => {
      const matches = detectUrls("Visit https://example.com/page.");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.text).toBe("https://example.com/page");
    });

    it("returns empty array for text with no URLs", () => {
      const matches = detectUrls("No links here");
      expect(matches).toHaveLength(0);
    });

    it("handles URLs with query parameters", () => {
      const matches = detectUrls("https://example.com/search?q=test&page=1");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.text).toBe("https://example.com/search?q=test&page=1");
    });

    it("handles URLs with fragments", () => {
      const matches = detectUrls("https://example.com/doc#section-2");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.text).toBe("https://example.com/doc#section-2");
    });

    it("captures start index of URL", () => {
      const matches = detectUrls("Go to https://example.com now");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.startIndex).toBe(6);
    });

    it("skips URLs that exceed the hot-path length cap", () => {
      const matches = detectUrls(`https://example.com/${"a".repeat(2050)}`);
      expect(matches).toHaveLength(0);
    });
  });

  describe("File path detection", () => {
    it("detects absolute file paths with recognized extensions", () => {
      const matches = detectFilePaths("Error in /src/main.ts at line 42");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.text).toBe("/src/main.ts");
    });

    it("detects relative file paths with recognized extensions", () => {
      const matches = detectFilePaths("See ./components/App.tsx for details");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.text).toBe("./components/App.tsx");
    });

    it("detects parent-relative paths", () => {
      const matches = detectFilePaths("Import from ../utils/helpers.js");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.text).toBe("../utils/helpers.js");
    });

    it("detects paths with line:col suffix", () => {
      const matches = detectFilePaths("Error at /src/index.ts:42:10");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.text).toBe("/src/index.ts:42:10");
    });

    it("rejects paths without recognized extensions", () => {
      const matches = detectFilePaths("See /usr/bin/node for binary");
      expect(matches).toHaveLength(0);
    });

    it("detects multiple file paths in one line", () => {
      const matches = detectFilePaths("Compare ./a.ts and ./b.js");
      expect(matches).toHaveLength(2);
    });

    it("handles various recognized extensions", () => {
      const extensions = ["ts", "js", "tsx", "jsx", "py", "rs", "go", "md", "json", "yaml", "yml", "toml", "css", "html", "sh", "sql"];
      for (const ext of extensions) {
        const matches = detectFilePaths(`/test/file.${ext}`);
        expect(matches.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("captures start index of file path", () => {
      const matches = detectFilePaths("See ./main.ts here");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.startIndex).toBe(4);
    });

    it("ignores bare directory paths without extensions", () => {
      const matches = detectFilePaths("In /usr/local/lib directory");
      expect(matches).toHaveLength(0);
    });
  });
});
