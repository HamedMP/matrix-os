import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getLeaderboard } from "../../packages/gateway/src/leaderboard.js";

describe("T2063: Leaderboard API", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "leaderboard-test-")));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("returns empty array when no data directory exists", () => {
    const result = getLeaderboard(homePath);
    expect(result).toEqual([]);
  });

  it("returns empty array when data directory is empty", () => {
    mkdirSync(join(homePath, "data"), { recursive: true });
    const result = getLeaderboard(homePath);
    expect(result).toEqual([]);
  });

  it("reads numeric score from best.json", () => {
    const dataDir = join(homePath, "data", "games-2048");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "best.json"), JSON.stringify(4096));

    const result = getLeaderboard(homePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      game: "2048",
      score: 4096,
    });
    expect(result[0].date).toBeDefined();
  });

  it("reads numeric score from highscore.json", () => {
    const dataDir = join(homePath, "data", "games-snake");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "highscore.json"), JSON.stringify(250));

    const result = getLeaderboard(homePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      game: "snake",
      score: 250,
    });
  });

  it("reads score from non-prefixed app data (e.g. ~/data/2048/best.json)", () => {
    const dataDir = join(homePath, "data", "2048");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "best.json"), JSON.stringify(8192));

    const result = getLeaderboard(homePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      game: "2048",
      score: 8192,
    });
  });

  it("extracts wins from stats object (chess/backgammon)", () => {
    const chessDir = join(homePath, "data", "games-chess");
    mkdirSync(chessDir, { recursive: true });
    writeFileSync(
      join(chessDir, "stats.json"),
      JSON.stringify({ wins: 10, losses: 5, draws: 3 }),
    );

    const result = getLeaderboard(homePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      game: "chess",
      score: 10,
    });
  });

  it("sorts by score descending across multiple games", () => {
    mkdirSync(join(homePath, "data", "games-2048"), { recursive: true });
    writeFileSync(join(homePath, "data", "games-2048", "best.json"), JSON.stringify(4096));

    mkdirSync(join(homePath, "data", "games-snake"), { recursive: true });
    writeFileSync(join(homePath, "data", "games-snake", "highscore.json"), JSON.stringify(500));

    mkdirSync(join(homePath, "data", "games-tetris"), { recursive: true });
    writeFileSync(join(homePath, "data", "games-tetris", "best.json"), JSON.stringify(12000));

    const result = getLeaderboard(homePath);
    expect(result).toHaveLength(3);
    expect(result[0].game).toBe("tetris");
    expect(result[0].score).toBe(12000);
    expect(result[1].game).toBe("2048");
    expect(result[1].score).toBe(4096);
    expect(result[2].game).toBe("snake");
    expect(result[2].score).toBe(500);
  });

  it("filters by game name", () => {
    mkdirSync(join(homePath, "data", "games-2048"), { recursive: true });
    writeFileSync(join(homePath, "data", "games-2048", "best.json"), JSON.stringify(4096));

    mkdirSync(join(homePath, "data", "games-snake"), { recursive: true });
    writeFileSync(join(homePath, "data", "games-snake", "highscore.json"), JSON.stringify(500));

    const result = getLeaderboard(homePath, "2048");
    expect(result).toHaveLength(1);
    expect(result[0].game).toBe("2048");
    expect(result[0].score).toBe(4096);
  });

  it("skips non-game directories in data/", () => {
    mkdirSync(join(homePath, "data", "calculator"), { recursive: true });
    writeFileSync(
      join(homePath, "data", "calculator", "history.json"),
      JSON.stringify([{ expr: "1+1", result: "2" }]),
    );

    mkdirSync(join(homePath, "data", "games-2048"), { recursive: true });
    writeFileSync(join(homePath, "data", "games-2048", "best.json"), JSON.stringify(2048));

    const result = getLeaderboard(homePath);
    expect(result).toHaveLength(1);
    expect(result[0].game).toBe("2048");
  });

  it("handles malformed JSON gracefully", () => {
    mkdirSync(join(homePath, "data", "games-2048"), { recursive: true });
    writeFileSync(join(homePath, "data", "games-2048", "best.json"), "not json");

    const result = getLeaderboard(homePath);
    expect(result).toEqual([]);
  });

  it("reads mtime as date from the score file", () => {
    const dataDir = join(homePath, "data", "games-2048");
    mkdirSync(dataDir, { recursive: true });
    const filePath = join(dataDir, "best.json");
    writeFileSync(filePath, JSON.stringify(4096));

    const result = getLeaderboard(homePath);
    expect(result).toHaveLength(1);
    expect(new Date(result[0].date).getTime()).toBeGreaterThan(0);
  });

  it("handles solitaire wins count", () => {
    mkdirSync(join(homePath, "data", "games-solitaire"), { recursive: true });
    writeFileSync(
      join(homePath, "data", "games-solitaire", "wins.json"),
      JSON.stringify(7),
    );

    const result = getLeaderboard(homePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      game: "solitaire",
      score: 7,
    });
  });

  it("prefers games-* prefixed data over bare name", () => {
    mkdirSync(join(homePath, "data", "games-2048"), { recursive: true });
    writeFileSync(join(homePath, "data", "games-2048", "best.json"), JSON.stringify(8192));

    mkdirSync(join(homePath, "data", "2048"), { recursive: true });
    writeFileSync(join(homePath, "data", "2048", "best.json"), JSON.stringify(4096));

    const result = getLeaderboard(homePath);
    // Should deduplicate -- games-* prefix takes priority
    const entries2048 = result.filter((e) => e.game === "2048");
    expect(entries2048).toHaveLength(1);
    expect(entries2048[0].score).toBe(8192);
  });
});
