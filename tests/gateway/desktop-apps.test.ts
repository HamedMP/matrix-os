import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APPS_DIR = join(__dirname, "../../home/apps");

const DESKTOP_APPS = [
  {
    slug: "browser",
    name: "Browser",
    runtime: "docker",
    port: 6901,
    category: "utility",
  },
  {
    slug: "vscode",
    name: "VS Code",
    runtime: "node",
    port: 3101,
    category: "productivity",
  },
];

describe("T1410-T1414: Bundled desktop apps", () => {
  for (const app of DESKTOP_APPS) {
    describe(app.slug, () => {
      const dir = join(APPS_DIR, app.slug);

      it("has a directory", () => {
        expect(existsSync(dir)).toBe(true);
      });

      it("has matrix.json", () => {
        expect(existsSync(join(dir, "matrix.json"))).toBe(true);
      });

      it("has index.html", () => {
        expect(existsSync(join(dir, "index.html"))).toBe(true);
      });

      it("matrix.json is valid JSON", () => {
        const raw = readFileSync(join(dir, "matrix.json"), "utf-8");
        const manifest = JSON.parse(raw);
        expect(manifest).toBeDefined();
      });

      it(`has name "${app.name}"`, () => {
        const manifest = JSON.parse(
          readFileSync(join(dir, "matrix.json"), "utf-8"),
        );
        expect(manifest.name).toBe(app.name);
      });

      it(`has runtime "${app.runtime}"`, () => {
        const manifest = JSON.parse(
          readFileSync(join(dir, "matrix.json"), "utf-8"),
        );
        expect(manifest.runtime).toBe(app.runtime);
      });

      it(`uses port ${app.port}`, () => {
        const manifest = JSON.parse(
          readFileSync(join(dir, "matrix.json"), "utf-8"),
        );
        expect(manifest.port).toBe(app.port);
      });

      it(`has category "${app.category}"`, () => {
        const manifest = JSON.parse(
          readFileSync(join(dir, "matrix.json"), "utf-8"),
        );
        expect(manifest.category).toBe(app.category);
      });

      it("has resource limits", () => {
        const manifest = JSON.parse(
          readFileSync(join(dir, "matrix.json"), "utf-8"),
        );
        expect(manifest.resources).toBeDefined();
        expect(manifest.resources.memory).toBe("512MB");
        expect(manifest.resources.cpu).toBe(1.0);
      });

      it("has network permission", () => {
        const manifest = JSON.parse(
          readFileSync(join(dir, "matrix.json"), "utf-8"),
        );
        expect(manifest.permissions).toContain("network");
      });

      it("autoStart is false", () => {
        const manifest = JSON.parse(
          readFileSync(join(dir, "matrix.json"), "utf-8"),
        );
        expect(manifest.autoStart).toBe(false);
      });

      it("has author system", () => {
        const manifest = JSON.parse(
          readFileSync(join(dir, "matrix.json"), "utf-8"),
        );
        expect(manifest.author).toBe("system");
      });

      it("index.html uses matrix theme variables", () => {
        const html = readFileSync(join(dir, "index.html"), "utf-8");
        expect(html).toContain("--matrix-bg");
      });

      it("index.html has proper HTML structure", () => {
        const html = readFileSync(join(dir, "index.html"), "utf-8");
        expect(html).toContain("<!DOCTYPE html>");
        expect(html).toContain("<title>");
        expect(html).toContain("</html>");
      });
    });
  }

  describe("browser-specific", () => {
    it("has docker runtime with entry chromium", () => {
      const manifest = JSON.parse(
        readFileSync(join(APPS_DIR, "browser", "matrix.json"), "utf-8"),
      );
      expect(manifest.runtime).toBe("docker");
      expect(manifest.entry).toBe("chromium");
    });

    it("index.html has URL bar", () => {
      const html = readFileSync(
        join(APPS_DIR, "browser", "index.html"),
        "utf-8",
      );
      expect(html).toContain("urlBar");
      expect(html).toContain("Enter URL");
    });

    it("index.html has navigation buttons", () => {
      const html = readFileSync(
        join(APPS_DIR, "browser", "index.html"),
        "utf-8",
      );
      expect(html).toContain("backBtn");
      expect(html).toContain("fwdBtn");
      expect(html).toContain("reloadBtn");
    });

    it("index.html has iframe for content", () => {
      const html = readFileSync(
        join(APPS_DIR, "browser", "index.html"),
        "utf-8",
      );
      expect(html).toContain("<iframe");
    });
  });

  describe("vscode-specific", () => {
    it("has node runtime with code-server entry", () => {
      const manifest = JSON.parse(
        readFileSync(join(APPS_DIR, "vscode", "matrix.json"), "utf-8"),
      );
      expect(manifest.runtime).toBe("node");
      expect(manifest.entry).toContain("code-server");
    });

    it("entry binds to port 3101", () => {
      const manifest = JSON.parse(
        readFileSync(join(APPS_DIR, "vscode", "matrix.json"), "utf-8"),
      );
      expect(manifest.entry).toContain("3101");
    });

    it("entry uses auth none for local access", () => {
      const manifest = JSON.parse(
        readFileSync(join(APPS_DIR, "vscode", "matrix.json"), "utf-8"),
      );
      expect(manifest.entry).toContain("--auth none");
    });

    it("has filesystem permission", () => {
      const manifest = JSON.parse(
        readFileSync(join(APPS_DIR, "vscode", "matrix.json"), "utf-8"),
      );
      expect(manifest.permissions).toContain("filesystem");
    });

    it("index.html has connection status indicator", () => {
      const html = readFileSync(
        join(APPS_DIR, "vscode", "index.html"),
        "utf-8",
      );
      expect(html).toContain("status");
      expect(html).toContain("Connecting");
    });

    it("index.html has feature descriptions", () => {
      const html = readFileSync(
        join(APPS_DIR, "vscode", "index.html"),
        "utf-8",
      );
      expect(html).toContain("IntelliSense");
      expect(html).toContain("Terminal");
      expect(html).toContain("Extensions");
      expect(html).toContain("Git");
    });

    it("index.html connects via modules proxy", () => {
      const html = readFileSync(
        join(APPS_DIR, "vscode", "index.html"),
        "utf-8",
      );
      expect(html).toContain("/modules/vscode/");
    });
  });
});
