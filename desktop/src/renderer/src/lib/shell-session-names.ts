const SHELL_SESSION_ADJECTIVES = [
  "swift", "calm", "bright", "bold", "brave", "clever", "cosmic", "crisp",
  "amber", "azure", "lunar", "solar", "misty", "quiet", "rapid", "shiny",
  "still", "vivid", "warm", "wild", "noble", "lucid", "fresh", "keen",
  "neat", "prime", "spry", "deft", "mellow", "nimble", "sleek", "stark",
] as const;

const SHELL_SESSION_NOUNS = [
  "falcon", "otter", "cedar", "river", "comet", "harbor", "meadow", "summit",
  "willow", "pine", "lynx", "heron", "maple", "delta", "ember", "quartz",
  "raven", "sparrow", "tide", "vale", "wren", "birch", "cobalt", "drift",
  "fern", "grove", "isle", "moss", "reef", "dune", "fjord", "atlas",
] as const;

export interface ShellSessionNameOptions {
  collisionFallback?: boolean;
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

function entropySuffix(): string {
  return Math.floor(Math.random() * 36 ** 5).toString(36).padStart(5, "0");
}

export function twoWordShellSessionName(options: ShellSessionNameOptions = {}): string {
  const base = `${pick(SHELL_SESSION_ADJECTIVES)}-${pick(SHELL_SESSION_NOUNS)}`;
  return options.collisionFallback ? `${base}-${entropySuffix()}` : base;
}
