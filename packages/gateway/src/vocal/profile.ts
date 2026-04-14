import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";

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
  // half-JSON profile on disk.
  const tmpPath = `${fullPath}.tmp-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  await rename(tmpPath, fullPath);

  return true;
}

export function renderProfileForPrompt(profile: VocalProfile | null): string {
  if (!profile || profile.facts.length === 0) return "";
  return (
    "\n\nWHAT YOU ALREADY KNOW ABOUT THIS PERSON (from previous vocal sessions):\n" +
    profile.facts.map((f) => `- ${f}`).join("\n") +
    "\n\nAct naturally on this knowledge — don't recite it, don't list it back. Use it the way a friend uses context about someone they already know. If something here feels out of date based on what they say now, trust the present conversation and call `remember` with the corrected fact."
  );
}
