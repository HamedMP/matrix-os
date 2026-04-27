import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LeaderboardEntry {
  game: string;
  score: number;
  date: string;
}

const KNOWN_GAMES = new Set([
  "snake",
  "2048",
  "tetris",
  "chess",
  "solitaire",
  "minesweeper",
  "backgammon",
]);

const SCORE_FILES = ["best.json", "highscore.json", "stats.json", "wins.json"];

function extractScore(filePath: string): number | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);

    if (typeof data === "number" && Number.isFinite(data)) {
      return data;
    }

    if (typeof data === "object" && data !== null) {
      if (typeof data.wins === "number") return data.wins;
      if (typeof data.score === "number") return data.score;
      if (typeof data.best === "number") return data.best;
    }

    return null;
  } catch (err: unknown) {
    console.warn("[leaderboard] Could not extract score:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function getFileMtime(filePath: string): string {
  try {
    const stat = statSync(filePath);
    return stat.mtime.toISOString();
  } catch (err: unknown) {
    console.warn("[leaderboard] Could not read score mtime:", err instanceof Error ? err.message : String(err));
    return new Date().toISOString();
  }
}

export function getLeaderboard(
  homePath: string,
  game?: string,
): LeaderboardEntry[] {
  const dataDir = join(homePath, "data");
  if (!existsSync(dataDir)) return [];

  let dirs: string[];
  try {
    dirs = readdirSync(dataDir);
  } catch (err: unknown) {
    console.warn("[leaderboard] Could not list data directory:", err instanceof Error ? err.message : String(err));
    return [];
  }

  const entries: LeaderboardEntry[] = [];
  const seen = new Set<string>();

  // First pass: games-* prefixed directories (higher priority)
  for (const dir of dirs) {
    if (!dir.startsWith("games-")) continue;
    const gameName = dir.slice(6); // strip "games-" prefix

    if (game && gameName !== game) continue;
    if (seen.has(gameName)) continue;

    const dirPath = join(dataDir, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch (err: unknown) {
      console.warn("[leaderboard] Could not inspect game directory:", err instanceof Error ? err.message : String(err));
      continue;
    }

    for (const scoreFile of SCORE_FILES) {
      const filePath = join(dirPath, scoreFile);
      if (!existsSync(filePath)) continue;

      const score = extractScore(filePath);
      if (score !== null) {
        seen.add(gameName);
        entries.push({
          game: gameName,
          score,
          date: getFileMtime(filePath),
        });
        break;
      }
    }
  }

  // Second pass: bare game name directories (only known games, lower priority)
  for (const dir of dirs) {
    if (dir.startsWith("games-")) continue;
    if (!KNOWN_GAMES.has(dir)) continue;

    if (game && dir !== game) continue;
    if (seen.has(dir)) continue;

    const dirPath = join(dataDir, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch (err: unknown) {
      console.warn("[leaderboard] Could not inspect game directory:", err instanceof Error ? err.message : String(err));
      continue;
    }

    for (const scoreFile of SCORE_FILES) {
      const filePath = join(dirPath, scoreFile);
      if (!existsSync(filePath)) continue;

      const score = extractScore(filePath);
      if (score !== null) {
        seen.add(dir);
        entries.push({
          game: dir,
          score,
          date: getFileMtime(filePath),
        });
        break;
      }
    }
  }

  return entries.sort((a, b) => b.score - a.score);
}
