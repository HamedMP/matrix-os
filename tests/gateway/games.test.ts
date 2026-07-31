import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppManifest } from "../../packages/gateway/src/app-manifest.js";

const GAMES_DIR = join(__dirname, "../../home/apps/games");
const SHARED_RENDERER = join(__dirname, "../../home/apps/_shared/default-apps.tsx");

const PLAYABLE_GAME_SLUGS = readdirSync(GAMES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((slug) => existsSync(join(GAMES_DIR, slug, "src/App.tsx")))
  .sort();

function expectViteAppScaffold(appDir: string) {
  const html = readFileSync(join(appDir, "index.html"), "utf-8");
  expect(html.toLowerCase()).toContain("<!doctype html>");
  expect(html).toContain('id="root"');
  expect(html).toContain('type="module"');
  expect(html).toContain("/src/main.tsx");
  expect(existsSync(join(appDir, "vite.config.ts"))).toBe(true);
}

function expectSharedRendererApp(appDir: string, appId: string) {
  expectViteAppScaffold(appDir);

  const source = readFileSync(join(appDir, "src/main.tsx"), "utf-8");
  expect(source).toContain("renderDefaultApp");
  expect(source).toContain(`"${appId}"`);
}

function expectPlayableGameApp(appDir: string) {
  expectViteAppScaffold(appDir);
  expect(existsSync(join(appDir, "src/App.tsx"))).toBe(true);

  const source = readFileSync(join(appDir, "src/main.tsx"), "utf-8");
  const appSource = readFileSync(join(appDir, "src/App.tsx"), "utf-8");
  expect(source).toContain("createRoot");
  expect(source).toContain('from "./App"');
  expect(source).not.toContain("renderDefaultApp");
  expect(appSource).toContain('import "./styles.css"');
}

describe("T1420-T1427: Pre-installed games", () => {
  describe("game launcher", () => {
    it("has a valid matrix.json", () => {
      const manifest = JSON.parse(readFileSync(join(GAMES_DIR, "matrix.json"), "utf-8"));
      const parsed = parseAppManifest(manifest);
      expect(parsed.name).toBe("Game Center");
      expect(parsed.category).toBe("utilities");
      expect(parsed.runtime).toBe("vite");
    });

    it("is a Vite app wired to the shared renderer", () => {
      expectSharedRendererApp(GAMES_DIR, "games");
    });
  });

  for (const slug of PLAYABLE_GAME_SLUGS) {
    describe(slug, () => {
      it("has a directory", () => {
        expect(existsSync(join(GAMES_DIR, slug))).toBe(true);
      });

      it("has a valid matrix.json", () => {
        const path = join(GAMES_DIR, slug, "matrix.json");
        expect(existsSync(path)).toBe(true);
        const manifest = JSON.parse(readFileSync(path, "utf-8"));
        const parsed = parseAppManifest(manifest);
        expect(parsed.name).toBeTruthy();
        expect(parsed.category).toBe("games");
        expect(parsed.runtime).toBe("vite");
        expect(parsed.version).toBeTruthy();
        expect(manifest.build.command).toContain("vite build");
        expect(manifest.build.output).toBe("dist");
      });

      it("is a Vite app wired to its playable App entrypoint", () => {
        expectPlayableGameApp(join(GAMES_DIR, slug));
      });
    });
  }

  it("keeps the game launcher UI in the shared app renderer", () => {
    const shared = readFileSync(SHARED_RENDERER, "utf-8");
    for (const slug of PLAYABLE_GAME_SLUGS) {
      expect(shared).toContain(slug);
    }
    expect(shared).toContain("gameCards");
    expect(shared).toContain("window.MatrixOS?.openApp");
    expect(shared).toContain("apps/${id}/index.html");
  });
});
