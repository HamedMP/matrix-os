import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const mockSurfaceRoots = [
  join(__dirname, "../components/shell"),
  join(__dirname, "../app/(drawer)"),
  join(__dirname, "../app/app-preview"),
  join(__dirname, "../app/file-browser"),
  join(__dirname, "../app/integration-detail"),
  join(__dirname, "../app/integrations-installed"),
  join(__dirname, "../app/terminal-session"),
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

describe("surface icon system", () => {
  it("uses HugeIcons without importing an entire icon catalog", () => {
    const sources = mockSurfaceRoots.flatMap(sourceFiles).map((path) => readFileSync(path, "utf8"));

    for (const source of sources) {
      expect(source).not.toContain("@expo/vector-icons");
      expect(source).not.toMatch(/from ["']@hugeicons\/core-free-icons["']/);
      expect(source).not.toMatch(/import \* as .*@hugeicons\/core-free-icons/);
    }
  });

  it("declares the native renderer and free icon data as mobile dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));

    expect(manifest.dependencies["@hugeicons/react-native"]).toBeDefined();
    expect(manifest.dependencies["@hugeicons/core-free-icons"]).toBeDefined();
  });
});
