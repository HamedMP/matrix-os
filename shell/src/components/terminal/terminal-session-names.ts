// Friendly session names (e.g. "swift-falcon") instead of
// "matrix-<random>". Both word lists are lowercase, slug-safe single words so
// the result always matches SHELL_SESSION_NAME_PATTERN.

export const SHELL_SESSION_ADJECTIVES = [
  "swift", "calm", "bright", "bold", "brave", "clever", "cosmic", "crisp",
  "amber", "azure", "lunar", "solar", "misty", "quiet", "rapid", "shiny",
  "still", "vivid", "warm", "wild", "noble", "lucid", "fresh", "keen",
  "neat", "prime", "spry", "deft", "mellow", "nimble", "sleek", "stark",
] as const;

export const SHELL_SESSION_NOUNS = [
  "falcon", "otter", "cedar", "river", "comet", "harbor", "meadow", "summit",
  "willow", "pine", "lynx", "heron", "maple", "delta", "ember", "quartz",
  "raven", "sparrow", "tide", "vale", "wren", "birch", "cobalt", "drift",
  "fern", "grove", "isle", "moss", "reef", "dune", "fjord", "atlas",
] as const;

export interface TwoWordSessionNameOptions {
  collisionFallback?: boolean;
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

function entropySuffix(): string {
  return Math.floor(Math.random() * 36 ** 5).toString(36).padStart(5, "0");
}

/** Returns a friendly session handle like "swift-falcon". */
export function twoWordSessionName(options: TwoWordSessionNameOptions = {}): string {
  const base = `${pick(SHELL_SESSION_ADJECTIVES)}-${pick(SHELL_SESSION_NOUNS)}`;
  return options.collisionFallback ? `${base}-${entropySuffix()}` : base;
}

/**
 * Deterministic accent color for a session, derived from its name so the same
 * session is always the same hue. Light tinted chip + matching darker text, so
 * sessions are told apart by color, not just a 2-3 letter abbreviation.
 */
export function sessionAccent(name: string): { bg: string; fg: string; border: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return {
    bg: `hsl(${hue} 58% 90%)`,
    fg: `hsl(${hue} 50% 30%)`,
    border: `hsl(${hue} 44% 78%)`,
  };
}
