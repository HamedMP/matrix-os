import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

// Per-home write lock. `appendFact` is read-modify-write, and Gemini can
// emit parallel `remember` tool calls — without a lock the second load
// races the first write and a fact gets lost (last-writer-wins). A single
// Promise chain per homePath serializes all writers for that home.
const writeLocks = new Map<string, Promise<unknown>>();
function withLock<T>(homePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(homePath) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeLocks.set(
    homePath,
    next.finally(() => {
      // Only clear if nothing else chained after us.
      if (writeLocks.get(homePath) === next) writeLocks.delete(homePath);
    }),
  );
  return next;
}

const PROFILE_PATH = "system/vocal-profile.json";
const MAX_FACTS = 50;
const MAX_FACT_LEN = 512;

export interface VocalProfile {
  facts: string[];
  updatedAt: string;
}

function sanitizeFact(raw: string): string | null {
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_FACT_LEN);
}

export async function loadProfile(homePath: string): Promise<VocalProfile | null> {
  try {
    const raw = await readFile(join(homePath, PROFILE_PATH), "utf-8");
    const data = JSON.parse(raw) as Partial<VocalProfile>;
    if (!Array.isArray(data.facts)) return null;
    return {
      facts: data.facts.filter((f): f is string => typeof f === "string").slice(0, MAX_FACTS),
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
    };
  } catch (err) {
    // Missing file is normal on first session. Anything else is worth
    // logging — a parse failure means a corrupt file we should know about.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[vocal] profile load failed:", err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}

export async function appendFact(homePath: string, rawFact: string): Promise<boolean> {
  const fact = sanitizeFact(rawFact);
  if (!fact) return false;

  return withLock(homePath, async () => {
    const current = (await loadProfile(homePath)) ?? { facts: [], updatedAt: new Date().toISOString() };

    // LLMs repeatedly re-save facts they already "know"; dedupe or the
    // profile bloats into duplicates over a long session.
    const lowered = fact.toLowerCase();
    if (current.facts.some((f) => f.toLowerCase() === lowered)) return false;

    const next: VocalProfile = {
      facts: [...current.facts, fact].slice(-MAX_FACTS),
      updatedAt: new Date().toISOString(),
    };

    const fullPath = join(homePath, PROFILE_PATH);
    await mkdir(dirname(fullPath), { recursive: true });

    // Atomic write: temp + rename, so a crash mid-write can't leave a
    // half-JSON profile on disk. `wx` refuses to overwrite an existing
    // tmp (randomBytes suffix makes collisions effectively impossible),
    // and the finally-block unlinks orphaned tmps if rename fails
    // (EXDEV, permissions) so we don't leak files on disk.
    const tmpPath = `${fullPath}.tmp-${randomBytes(8).toString("hex")}`;
    let renamed = false;
    try {
      await writeFile(tmpPath, JSON.stringify(next, null, 2) + "\n", { encoding: "utf-8", flag: "wx" });
      await rename(tmpPath, fullPath);
      renamed = true;
    } finally {
      if (!renamed) {
        await unlink(tmpPath).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") {
            console.warn("[vocal] tmp cleanup failed:", err.message);
          }
        });
      }
    }

    return true;
  });
}

export function renderProfileForPrompt(profile: VocalProfile | null): string {
  if (!profile || profile.facts.length === 0) return "";
  return (
    "\n\nWHAT YOU ALREADY KNOW ABOUT THIS PERSON (from previous vocal sessions):\n" +
    profile.facts.map((f) => `- ${f}`).join("\n") +
    "\n\nAct naturally on this knowledge — don't recite it, don't list it back. Use it the way a friend uses context about someone they already know. If something here feels out of date based on what they say now, trust the present conversation and call `remember` with the corrected fact."
  );
}
