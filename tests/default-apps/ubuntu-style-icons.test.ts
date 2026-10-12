import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const core = [
  "chat", "terminal", "files", "editor", "settings", "plugins",
  "browser", "notes", "whiteboard", "canvas", "desktop", "create-app",
];
const gallery = [
  "folio", "atlas", "agenda", "follow-ups", "deliveries", "reading-library",
  "people", "files", "notes", "habits", "focus", "cashflow", "revenue",
  "pipeline", "projects", "meeting-briefs", "support", "hiring",
  "company-spend", "releases", "knowledge", "campaigns", "analytics",
  "workout-coach", "paycheck-runway", "meal-planner", "job-search",
  "study-notes", "journal-memory", "chess-coach", "subscriptions",
];

describe("distinct bundled app artwork", () => {
  it.each(gallery)("uses matching freestanding %s artwork in Gallery and launcher", async (stem) => {
    const png = await readFile(`home/apps/app-gallery/src/assets/icons/${stem}.png`);
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let opaque = 0;
    for (let pixel = 3; pixel < data.length; pixel += info.channels) if (data[pixel]! > 32) opaque++;
    expect(opaque / (info.width * info.height)).toBeLessThan(0.78);
    expect(data[3]).toBeLessThan(12);
    expect(await readFile(`home/system/icons/gallery-${stem}.png`)).toEqual(png);
  });
  it("uses a freestanding Subscriptions icon in the Gallery and installed launcher", async () => {
    const png = await readFile("home/apps/app-gallery/src/assets/icons/subscriptions.png");
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let opaque = 0;
    for (let pixel = 3; pixel < data.length; pixel += info.channels) if (data[pixel]! > 32) opaque++;
    expect(opaque / (info.width * info.height)).toBeLessThan(0.78);
    expect(await readFile("home/system/icons/gallery-subscriptions.png")).toEqual(png);
  });
  it.each(core)("renders %s as a freestanding icon without a full tile", async (stem) => {
    const png = await readFile(`shell/public/system-app-icons/v2/${stem}.png`);
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let opaque = 0;
    for (let pixel = 3; pixel < data.length; pixel += info.channels) if (data[pixel]! > 32) opaque++;
    expect(opaque / (info.width * info.height)).toBeLessThan(0.78);
    expect(data[3]).toBeLessThan(12);
  });

  it.each(["chess", "clock", "expense-tracker", "app-gallery", "minesweeper", "pomodoro-timer", "resource-manager", "snake", "solitaire", "task-manager", "tetris", "weather", "calculator", "2048", "backgammon", "game-center", "todo"])(
    "renders %s with a transparent, independent silhouette",
    async (stem) => {
      const png = await readFile(`home/system/icons/v3-${stem}.png`);
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let opaque = 0;
      for (let pixel = 3; pixel < data.length; pixel += info.channels) if (data[pixel]! > 32) opaque++;
      expect(opaque / (info.width * info.height)).toBeLessThan(0.78);
      expect(data[3]).toBeLessThan(12);
    },
  );

  it("selects versioned artwork for bundled apps so existing customized icon files stay owned", async () => {
    const manifests = {
      "app-gallery": "home/apps/app-gallery/matrix.json",
      chess: "home/apps/games/chess/matrix.json",
      calculator: "home/apps/calculator/matrix.json",
      "expense-tracker": "home/apps/expense-tracker/matrix.json",
      todo: "home/apps/todo/matrix.json",
    };
    for (const [stem, path] of Object.entries(manifests)) {
      const manifest = JSON.parse(await readFile(path, "utf8")) as { icon: string };
      expect(manifest.icon).toBe(`v3-${stem}`);
    }
  });
});
