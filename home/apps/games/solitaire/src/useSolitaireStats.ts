import { useCallback, useEffect, useRef, useState } from "react";

const STATS_TABLE = "stats";

export interface Stats {
  id?: string;
  games_played: number;
  games_won: number;
  best_time: number; // seconds, 0 = none
  best_moves: number; // 0 = none
}

const EMPTY_STATS: Stats = { games_played: 0, games_won: 0, best_time: 0, best_moves: 0 };

function coerceStats(row: unknown): Stats {
  if (!row || typeof row !== "object") return { ...EMPTY_STATS };
  const r = row as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    games_played: num(r.games_played),
    games_won: num(r.games_won),
    best_time: num(r.best_time),
    best_moves: num(r.best_moves),
  };
}

export function useSolitaireStats({ countInitialGame }: { countInitialGame: boolean }) {
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [error, setError] = useState<string | null>(null);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const statsRef = useRef<Stats>(EMPTY_STATS);
  const statsLoadedRef = useRef(false);
  const statsRowIdRef = useRef<string | null>(null);
  const statsInsertRef = useRef<Promise<string> | null>(null);
  const statsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const statsWriteVersionRef = useRef(0);
  const pendingGamesPlayedRef = useRef(0);
  const countedInitialGameRef = useRef(countInitialGame);

  useEffect(() => {
    statsRef.current = stats;
  }, [stats]);

  const clearStatsError = useCallback(() => {
    setError(null);
  }, []);

  const persistStats = useCallback((next: Stats) => {
    statsWriteVersionRef.current += 1;
    statsRef.current = next;
    setStats(next);
    const db = window.MatrixOS?.db;
    if (!db) return Promise.resolve();
    const save = async () => {
      const payload = {
        games_played: next.games_played,
        games_won: next.games_won,
        best_time: next.best_time,
        best_moves: next.best_moves,
      };
      try {
        const rowId = next.id ?? statsRowIdRef.current;
        if (rowId) {
          statsRowIdRef.current = rowId;
          await db.update(STATS_TABLE, rowId, payload);
        } else {
          let createdForThisSave = false;
          if (!statsInsertRef.current) {
            createdForThisSave = true;
            statsInsertRef.current = db.insert(STATS_TABLE, payload)
              .then((res) => {
                statsRowIdRef.current = res.id;
                setStats((cur) => ({ ...cur, id: res.id }));
                return res.id;
              })
              .finally(() => {
                statsInsertRef.current = null;
              });
          }
          const insertedId = await statsInsertRef.current;
          if (!createdForThisSave) {
            await db.update(STATS_TABLE, insertedId, payload);
          }
        }
      } catch (err: unknown) {
        console.warn("[solitaire] stats save failed:", err instanceof Error ? err.message : String(err));
        setError("Stats could not be saved to Matrix Postgres.");
      }
    };
    const run = statsSaveQueueRef.current.then(save, save);
    statsSaveQueueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const loadStats = useCallback(async () => {
    const db = window.MatrixOS?.db;
    const writeVersionAtStart = statsWriteVersionRef.current;
    if (!db) {
      setStats({ ...EMPTY_STATS });
      statsLoadedRef.current = true;
      setStatsLoaded(true);
      return;
    }
    try {
      const rows = await db.find(STATS_TABLE, { limit: 1 });
      if (rows && rows.length > 0) {
        const loaded = coerceStats(rows[0]);
        statsRowIdRef.current = loaded.id ?? null;
        if (statsWriteVersionRef.current === writeVersionAtStart) {
          setStats(loaded);
        }
      } else {
        if (statsWriteVersionRef.current === writeVersionAtStart) {
          setStats({ ...EMPTY_STATS });
        }
      }
      setError(null);
    } catch (err: unknown) {
      console.warn("[solitaire] stats load failed:", err instanceof Error ? err.message : String(err));
      setError("Stats could not be loaded.");
      setStats({ ...EMPTY_STATS });
    }
    statsLoadedRef.current = true;
    setStatsLoaded(true);
  }, []);

  useEffect(() => {
    void loadStats();
    const db = window.MatrixOS?.db;
    return db?.onChange?.(STATS_TABLE, () => void loadStats());
  }, [loadStats]);

  const recordGamePlayed = useCallback(() => {
    countedInitialGameRef.current = true;
    if (!statsLoadedRef.current) {
      pendingGamesPlayedRef.current += 1;
      return;
    }
    const cur = statsRef.current;
    const next = { ...cur, games_played: cur.games_played + 1 };
    statsRef.current = next;
    void persistStats(next);
  }, [persistStats]);

  useEffect(() => {
    if (!statsLoaded) return;
    let increment = pendingGamesPlayedRef.current;
    pendingGamesPlayedRef.current = 0;
    if (!countedInitialGameRef.current) {
      countedInitialGameRef.current = true;
      increment += 1;
    }
    if (increment === 0) return;
    const cur = statsRef.current;
    const next = { ...cur, games_played: cur.games_played + increment };
    statsRef.current = next;
    void persistStats(next);
  }, [persistStats, statsLoaded]);

  const recordWin = useCallback((time: number, moves: number) => {
    const cur = statsRef.current;
    void persistStats({
      ...cur,
      games_won: cur.games_won + 1,
      best_time: cur.best_time === 0 ? time : Math.min(cur.best_time, time),
      best_moves: cur.best_moves === 0 ? moves : Math.min(cur.best_moves, moves),
    });
  }, [persistStats]);

  return { stats, error, clearStatsError, recordGamePlayed, recordWin };
}
