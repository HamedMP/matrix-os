import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { listApps } from "../../packages/gateway/src/apps.js";

describe("T711: GET /api/apps", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "apps-test-")));
    mkdirSync(join(homePath, "apps"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("returns empty array when no apps exist", async () => {
    const apps = await listApps(homePath);
    expect(apps).toEqual([]);
  });

  it("lists HTML apps with metadata from matrix.md", async () => {
    writeFileSync(join(homePath, "apps/todo.html"), "<html></html>");
    writeFileSync(
      join(homePath, "apps/todo.matrix.md"),
      "---\nname: Todo\ndescription: Task manager\ncategory: productivity\nicon: check\n---\n",
    );

    const apps = await listApps(homePath);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toEqual({
      name: "Todo",
      description: "Task manager",
      category: "productivity",
      icon: "check",
      file: "todo.html",
      path: "/files/apps/todo.html",
    });
  });

  it("lists multiple apps sorted by name", async () => {
    writeFileSync(join(homePath, "apps/notes.html"), "<html></html>");
    writeFileSync(join(homePath, "apps/notes.matrix.md"), "---\nname: Notes\ncategory: productivity\n---\n");
    writeFileSync(join(homePath, "apps/calc.html"), "<html></html>");
    writeFileSync(join(homePath, "apps/calc.matrix.md"), "---\nname: Calculator\ncategory: utility\n---\n");

    const apps = await listApps(homePath);
    expect(apps).toHaveLength(2);
    expect(apps[0].name).toBe("Calculator");
    expect(apps[1].name).toBe("Notes");
  });

  it("uses defaults when matrix.md is missing", async () => {
    writeFileSync(join(homePath, "apps/widget.html"), "<html></html>");

    const apps = await listApps(homePath);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("widget");
    expect(apps[0].category).toBe("utility");
    expect(apps[0].path).toBe("/files/apps/widget.html");
  });

  it("ignores non-HTML files", async () => {
    writeFileSync(join(homePath, "apps/readme.md"), "# readme");
    writeFileSync(join(homePath, "apps/todo.html"), "<html></html>");

    const apps = await listApps(homePath);
    expect(apps).toHaveLength(1);
    expect(apps[0].file).toBe("todo.html");
  });

  it("does not list app templates as installed apps", async () => {
    mkdirSync(join(homePath, "apps/_template-next"), { recursive: true });
    writeFileSync(join(homePath, "apps/_template-next/index.html"), "<html></html>");
    writeFileSync(
      join(homePath, "apps/_template-next/matrix.json"),
      JSON.stringify({ name: "My Next App", runtime: "node" }),
    );
    writeFileSync(join(homePath, "apps/real.html"), "<html></html>");

    const apps = await listApps(homePath);

    expect(apps.map((app) => app.name)).toEqual(["real"]);
  });

  it("returns empty when apps directory does not exist", async () => {
    rmSync(join(homePath, "apps"), { recursive: true, force: true });
    const apps = await listApps(homePath);
    expect(apps).toEqual([]);
  });

  it("skips broken filesystem entries and still returns readable apps", async () => {
    writeFileSync(join(homePath, "apps/notes.html"), "<html></html>");
    writeFileSync(join(homePath, "apps/notes.matrix.md"), "---\nname: Notes\ncategory: productivity\n---\n");
    symlinkSync(join(homePath, "apps/missing-target"), join(homePath, "apps/broken-link"));

    const apps = await listApps(homePath);

    expect(apps.map((app) => app.name)).toEqual(["Notes"]);
  });

  it("skips malformed app manifests and keeps scanning siblings", async () => {
    mkdirSync(join(homePath, "apps/bad-app"), { recursive: true });
    writeFileSync(join(homePath, "apps/bad-app/matrix.json"), "{ bad json");
    mkdirSync(join(homePath, "apps/good-app"), { recursive: true });
    writeFileSync(join(homePath, "apps/good-app/index.html"), "<html></html>");
    writeFileSync(
      join(homePath, "apps/good-app/matrix.json"),
      JSON.stringify({ name: "Good App", slug: "good-app", version: "1.0.0", runtimeVersion: "^1.0.0", category: "utility", runtime: "static" }),
    );

    const apps = await listApps(homePath);

    expect(apps.map((app) => app.name)).toEqual(["Good App"]);
  });

  it("does not list hidden runtime apps", async () => {
    mkdirSync(join(homePath, "apps/symphony/dist"), { recursive: true });
    writeFileSync(join(homePath, "apps/symphony/dist/index.html"), "<html></html>");
    writeFileSync(
      join(homePath, "apps/symphony/matrix.json"),
      JSON.stringify({
        name: "Symphony",
        slug: "symphony",
        version: "1.0.0",
        runtimeVersion: "^1.0.0",
        category: "developer",
        runtime: "vite",
        hidden: true,
        build: { command: "vite build", output: "dist" },
      }),
    );

    const apps = await listApps(homePath);

    expect(apps.map((app) => app.name)).not.toContain("Symphony");
  });

  it("does not warn for ordinary nested directories without manifests", async () => {
    mkdirSync(join(homePath, "apps/generated/app/api/health"), { recursive: true });
    mkdirSync(join(homePath, "apps/generated/src/components"), { recursive: true });
    mkdirSync(join(homePath, "apps/ready/dist"), { recursive: true });
    writeFileSync(join(homePath, "apps/ready/dist/index.html"), "<html>built</html>");
    writeFileSync(
      join(homePath, "apps/ready/matrix.json"),
      JSON.stringify({
        name: "Ready",
        slug: "ready",
        version: "1.0.0",
        runtimeVersion: "^1.0.0",
        category: "utility",
        runtime: "vite",
        build: { command: "pnpm build", output: "dist" },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const apps = await listApps(homePath);

      expect(apps.map((app) => app.name)).toEqual(["Ready"]);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("generated/app/api"));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("generated/src"));
    } finally {
      warn.mockRestore();
    }
  });

  it("returns empty when the apps directory is not a readable directory", async () => {
    rmSync(join(homePath, "apps"), { recursive: true, force: true });
    symlinkSync(join(homePath, "missing-apps"), join(homePath, "apps"));

    const apps = await listApps(homePath);

    expect(apps).toEqual([]);
  });

  describe("design-scoped app visibility", () => {
    const writeRuntimeApp = (slug: string, extra: Record<string, unknown> = {}) => {
      mkdirSync(join(homePath, `apps/${slug}`), { recursive: true });
      writeFileSync(join(homePath, `apps/${slug}/index.html`), "<html></html>");
      writeFileSync(
        join(homePath, `apps/${slug}/matrix.json`),
        JSON.stringify({
          name: slug,
          slug,
          version: "1.0.0",
          runtimeVersion: "^1.0.0",
          category: "utility",
          runtime: "static",
          ...extra,
        }),
      );
    };

    const writeTheme = (style: unknown) => {
      mkdirSync(join(homePath, "system"), { recursive: true });
      writeFileSync(
        join(homePath, "system/theme.json"),
        JSON.stringify({ name: "Test", mode: "dark", style }),
      );
    };

    it("lists apps without designs regardless of the active design", async () => {
      writeRuntimeApp("plain-app");
      writeTheme("winxp");

      const apps = await listApps(homePath);

      expect(apps.map((app) => app.slug)).toEqual(["plain-app"]);
    });

    it("lists a design-scoped app when the active design matches", async () => {
      writeRuntimeApp("xp-app", { designs: ["winxp"] });
      writeTheme("winxp");

      const apps = await listApps(homePath);

      expect(apps.map((app) => app.slug)).toEqual(["xp-app"]);
    });

    it("hides a design-scoped app when the active design does not match", async () => {
      writeRuntimeApp("xp-app", { designs: ["winxp"] });
      writeRuntimeApp("plain-app");
      writeTheme("macos-glass");

      const apps = await listApps(homePath);

      expect(apps.map((app) => app.slug)).toEqual(["plain-app"]);
    });

    it("keeps inactive design-scoped apps available to runtime provisioning", async () => {
      writeRuntimeApp("xp-app", {
        designs: ["winxp"],
        storage: { tables: { scores: { columns: { value: "integer" } } } },
      });
      writeTheme("macos-glass");

      const apps = await listApps(homePath, { includeInactiveDesigns: true });

      expect(apps.map((app) => app.slug)).toEqual(["xp-app"]);
    });

    it("defaults to flat when theme.json is missing", async () => {
      writeRuntimeApp("flat-app", { designs: ["flat", "winxp"] });
      writeRuntimeApp("xp-app", { designs: ["winxp"] });

      const apps = await listApps(homePath);

      expect(apps.map((app) => app.slug)).toEqual(["flat-app"]);
    });

    it("defaults to flat when theme.json style is not a known design id", async () => {
      writeRuntimeApp("flat-app", { designs: ["flat"] });
      writeRuntimeApp("xp-app", { designs: ["winxp"] });
      writeTheme("beos");

      const apps = await listApps(homePath);

      expect(apps.map((app) => app.slug)).toEqual(["flat-app"]);
    });

    it("keeps listing apps when theme.json is malformed", async () => {
      writeRuntimeApp("plain-app");
      writeRuntimeApp("flat-app", { designs: ["flat"] });
      writeRuntimeApp("xp-app", { designs: ["winxp"] });
      mkdirSync(join(homePath, "system"), { recursive: true });
      writeFileSync(join(homePath, "system/theme.json"), "{ bad json");

      const apps = await listApps(homePath);

      expect(apps.map((app) => app.slug)).toEqual(["flat-app", "plain-app"]);
    });

    it("rejects manifests with an empty designs array", async () => {
      writeRuntimeApp("empty-designs", { designs: [] });
      writeRuntimeApp("plain-app");

      const apps = await listApps(homePath);

      expect(apps.map((app) => app.slug)).toEqual(["plain-app"]);
    });
  });

  it("discovers apps in nested subdirectories", async () => {
    mkdirSync(join(homePath, "apps/games"), { recursive: true });
    writeFileSync(
      join(homePath, "apps/games/matrix.json"),
      JSON.stringify({ name: "Game Center", slug: "games", version: "1.0.0", runtimeVersion: "^1.0.0", category: "utilities", runtime: "static" }),
    );

    mkdirSync(join(homePath, "apps/games/snake"), { recursive: true });
    writeFileSync(join(homePath, "apps/games/snake/index.html"), "<html></html>");
    writeFileSync(
      join(homePath, "apps/games/snake/matrix.json"),
      JSON.stringify({ name: "Snake", slug: "snake", version: "1.0.0", runtimeVersion: "^1.0.0", category: "games", runtime: "static" }),
    );

    mkdirSync(join(homePath, "apps/games/2048"), { recursive: true });
    writeFileSync(join(homePath, "apps/games/2048/index.html"), "<html></html>");
    writeFileSync(
      join(homePath, "apps/games/2048/matrix.json"),
      JSON.stringify({ name: "2048", slug: "2048", version: "1.0.0", runtimeVersion: "^1.0.0", category: "games", runtime: "static" }),
    );

    const apps = await listApps(homePath);
    const names = apps.map((a) => a.name);
    expect(names).toContain("Game Center");
    expect(names).toContain("Snake");
    expect(names).toContain("2048");

    const snake = apps.find((a) => a.name === "Snake")!;
    expect(snake.path).toBe("/files/apps/games/snake/index.html");
    expect(snake.file).toBe("games/snake/index.html");
    expect(snake.category).toBe("games");
    expect(snake.slug).toBe("snake");
    expect(snake.runtime).toBe("static");
    expect(snake.runtimeState).toEqual({ status: "ready" });
    expect(snake.launchUrl).toBe("/apps/snake/");
  });

  it("uses manifest slug for nested launch URLs and reports vite build readiness", async () => {
    mkdirSync(join(homePath, "apps/games/chess/dist"), { recursive: true });
    writeFileSync(join(homePath, "apps/games/chess/dist/index.html"), "<html>built</html>");
    writeFileSync(
      join(homePath, "apps/games/chess/matrix.json"),
      JSON.stringify({
        name: "Chess",
        slug: "chess",
        category: "games",
        runtime: "vite",
        version: "1.0.0",
        runtimeVersion: "^1.0.0",
        build: { command: "vite build --base ./ --outDir dist", output: "dist" },
      }),
    );

    const apps = await listApps(homePath);
    expect(apps).toEqual([
      expect.objectContaining({
        name: "Chess",
        slug: "chess",
        runtime: "vite",
        runtimeState: { status: "ready" },
        launchUrl: "/apps/chess/",
        path: "/files/apps/games/chess/index.html",
      }),
    ]);
  });

  it("reports needs_build for vite apps without built output", async () => {
    mkdirSync(join(homePath, "apps/games/chess"), { recursive: true });
    writeFileSync(
      join(homePath, "apps/games/chess/matrix.json"),
      JSON.stringify({
        name: "Chess",
        slug: "chess",
        category: "games",
        runtime: "vite",
        version: "1.0.0",
        runtimeVersion: "^1.0.0",
        build: { command: "vite build --base ./ --outDir dist", output: "dist" },
      }),
    );

    const apps = await listApps(homePath);
    expect(apps[0]).toMatchObject({
      slug: "chess",
      runtimeState: { status: "needs_build" },
      launchUrl: "/apps/chess/",
    });
  });

  it("lists nested apps alongside top-level apps", async () => {
    writeFileSync(join(homePath, "apps/notes.html"), "<html></html>");
    writeFileSync(join(homePath, "apps/notes.matrix.md"), "---\nname: Notes\ncategory: productivity\n---\n");

    mkdirSync(join(homePath, "apps/tools/timer"), { recursive: true });
    writeFileSync(join(homePath, "apps/tools/timer/index.html"), "<html></html>");
    writeFileSync(
      join(homePath, "apps/tools/timer/matrix.json"),
      JSON.stringify({ name: "Timer", slug: "timer", version: "1.0.0", runtimeVersion: "^1.0.0", category: "utilities", runtime: "static" }),
    );

    const apps = await listApps(homePath);
    const names = apps.map((a) => a.name);
    expect(names).toContain("Notes");
    expect(names).toContain("Timer");
  });

  it("ships icons for every default app manifest", () => {
    const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const appsRoot = join(repoRoot, "home/apps");
    const iconsRoot = join(repoRoot, "home/system/icons");
    const shippedIcons = new Set(
      readdirSync(iconsRoot)
        .filter((file) => file.endsWith(".png") || file.endsWith(".svg"))
        .map((file) => file.replace(/\.(?:png|svg)$/, "")),
    );
    const missing: string[] = [];

    const visit = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith("_template-")) {
          continue;
        }
        const fullPath = join(dir, entry);
        if (statSync(fullPath).isDirectory()) {
          visit(fullPath);
          continue;
        }
        if (entry !== "matrix.json") {
          continue;
        }
        const manifest = JSON.parse(readFileSync(fullPath, "utf8")) as { icon?: unknown };
        if (typeof manifest.icon === "string" && !shippedIcons.has(manifest.icon)) {
          missing.push(`${fullPath.replace(`${repoRoot}/`, "")}: ${manifest.icon}`);
        }
      }
    };

    visit(appsRoot);

    expect(missing).toEqual([]);
  });

  it("ships exactly one visible Minesweeper app for every supported design", () => {
    const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const manifests = [
      "home/apps/games/minesweeper/matrix.json",
      "home/apps/winxp-minesweeper/matrix.json",
    ].map((path) => JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as {
      name: string;
      designs?: string[];
    });

    for (const design of ["flat", "neumorphic", "macos-glass", "winxp", "win11"]) {
      const visible = manifests.filter((manifest) => !manifest.designs || manifest.designs.includes(design));
      expect(visible, design).toHaveLength(1);
      expect(visible[0]?.name).toBe("Minesweeper");
    }
  });

  it("ships the clock and win11 sticky-notes manifests with first-party metadata", () => {
    const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const read = (slug: string) =>
      JSON.parse(readFileSync(join(repoRoot, "home/apps", slug, "matrix.json"), "utf8")) as Record<string, unknown>;
    const shippedIcons = new Set(
      readdirSync(join(repoRoot, "home/system/icons"))
        .filter((file) => file.endsWith(".png") || file.endsWith(".svg"))
        .map((file) => file.replace(/\.(?:png|svg)$/, "")),
    );

    const clock = read("clock");
    expect(clock).toMatchObject({
      name: "Clock",
      slug: "clock",
      runtime: "vite",
      icon: "clock",
      author: "system",
      listingTrust: "first_party",
      runtimeVersion: "^1.0.0",
      build: { output: "dist" },
    });
    // Available in every design: no designs scoping.
    expect(clock.designs).toBeUndefined();
    expect(shippedIcons.has("clock")).toBe(true);

    const stickyNotes = read("win-sticky-notes");
    expect(stickyNotes).toMatchObject({
      name: "Sticky Notes",
      slug: "win-sticky-notes",
      runtime: "vite",
      icon: "sticky-notes",
      author: "system",
      listingTrust: "first_party",
      runtimeVersion: "^1.0.0",
      designs: ["win11"],
      build: { output: "dist" },
    });
    expect(shippedIcons.has("sticky-notes")).toBe(true);
  });

  it("ships default apps as Vite apps with explicit build output", () => {
    const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const appsRoot = join(repoRoot, "home/apps");
    const staticApps: string[] = [];
    const missingBuild: string[] = [];

    const visit = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith("_")) continue;
        const fullPath = join(dir, entry);
        if (!statSync(fullPath).isDirectory()) continue;
        const manifestPath = join(fullPath, "matrix.json");
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            runtime?: unknown;
            build?: { output?: unknown };
          };
          if (manifest.runtime !== "vite") {
            staticApps.push(manifestPath.replace(`${repoRoot}/`, ""));
          }
          if (manifest.build?.output !== "dist") {
            missingBuild.push(manifestPath.replace(`${repoRoot}/`, ""));
          }
        } catch {
          // Directories without manifests are not launchable default apps.
        }
        visit(fullPath);
      }
    };

    visit(appsRoot);

    expect(staticApps).toEqual([]);
    expect(missingBuild).toEqual([]);
  });
});
