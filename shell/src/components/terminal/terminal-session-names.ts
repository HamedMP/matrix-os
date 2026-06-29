// Friendly two-word session names (e.g. "swift-falcon") instead of
// "matrix-<random>". Both lists are lowercase, slug-safe single words so the
// result always matches SHELL_SESSION_NAME_PATTERN.

const ADJECTIVES = [
  "swift", "calm", "bright", "bold", "brave", "clever", "cosmic", "crisp",
  "amber", "azure", "lunar", "solar", "misty", "quiet", "rapid", "shiny",
  "still", "vivid", "warm", "wild", "noble", "lucid", "fresh", "keen",
  "neat", "prime", "spry", "deft", "mellow", "nimble", "sleek", "stark",
] as const;

const NOUNS = [
  "falcon", "otter", "cedar", "river", "comet", "harbor", "meadow", "summit",
  "willow", "pine", "lynx", "heron", "maple", "delta", "ember", "quartz",
  "raven", "sparrow", "tide", "vale", "wren", "birch", "cobalt", "drift",
  "fern", "grove", "isle", "moss", "reef", "dune", "fjord", "atlas",
] as const;

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/** Returns a friendly two-word session handle like "swift-falcon". */
export function twoWordSessionName(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}
