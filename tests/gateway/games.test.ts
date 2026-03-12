import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppManifest } from "../../packages/gateway/src/app-manifest.js";

const GAMES_DIR = join(__dirname, "../../home/apps/games");

const GAME_SLUGS = ["snake", "2048", "minesweeper", "tetris", "solitaire", "chess"];

describe("T1420-T1427: Pre-installed games", () => {
  describe("game launcher", () => {
    it("has a valid matrix.json", () => {
      const manifest = JSON.parse(readFileSync(join(GAMES_DIR, "matrix.json"), "utf-8"));
      const parsed = parseAppManifest(manifest);
      expect(parsed.name).toBe("Game Center");
      expect(parsed.category).toBe("utilities");
      expect(parsed.runtime).toBe("static");
    });

    it("has an index.html", () => {
      expect(existsSync(join(GAMES_DIR, "index.html"))).toBe(true);
    });
  });

  for (const slug of GAME_SLUGS) {
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
        expect(parsed.runtime).toBe("static");
        expect(parsed.version).toBeTruthy();
      });

      it("has an index.html", () => {
        expect(existsSync(join(GAMES_DIR, slug, "index.html"))).toBe(true);
      });

      it("index.html contains game content", () => {
        const html = readFileSync(join(GAMES_DIR, slug, "index.html"), "utf-8");
        expect(html).toContain("<!DOCTYPE html>");
        expect(html).toContain("<title>");
        expect(html).toContain("<script>");
      });

      it("uses bridge API for persistence", () => {
        const html = readFileSync(join(GAMES_DIR, slug, "index.html"), "utf-8");
        expect(html).toContain("/api/bridge/data");
      });

      it("has sound effects via Web Audio API", () => {
        const html = readFileSync(join(GAMES_DIR, slug, "index.html"), "utf-8");
        expect(html).toContain("AudioContext");
      });
    });
  }
});
