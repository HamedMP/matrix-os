// Friendly two-word display names for sessions. The gateway's zellij session
// names are opaque (matrix-<id>); we derive a stable, readable "adjective-noun"
// label from the attach name deterministically (same name → same label) so the
// UI never shows a random hash. The real attach name is still used to connect.

const ADJECTIVES = [
  "amber", "azure", "bold", "brave", "bright", "calm", "clever", "cosmic",
  "crisp", "deft", "eager", "fancy", "fleet", "gentle", "glad", "golden",
  "happy", "ivory", "jolly", "keen", "lucid", "lunar", "mellow", "merry",
  "noble", "olive", "prime", "quiet", "rapid", "royal", "sage", "sharp",
  "sleek", "snug", "solar", "spry", "still", "sunny", "swift", "tidy",
  "vivid", "warm", "wise", "witty", "zesty", "zen", "fresh", "lively",
];

const NOUNS = [
  "otter", "falcon", "maple", "river", "ember", "comet", "lynx", "heron",
  "willow", "cedar", "harbor", "meadow", "summit", "canyon", "orchard", "delta",
  "finch", "badger", "marten", "puffin", "raven", "sparrow", "beacon", "anchor",
  "lantern", "compass", "harvest", "thicket", "glacier", "quartz", "cobalt", "indigo",
  "basil", "clover", "fennel", "juniper", "saffron", "tundra", "cove", "fjord",
  "atlas", "nimbus", "zephyr", "pebble", "ripple", "cinder", "bramble", "marlin",
];

function hash32(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable "adjective-noun" label for an attach name (e.g. "brave-otter"). */
export function friendlySessionName(attachName: string): string {
  const h = hash32(attachName);
  const adjective = ADJECTIVES[h % ADJECTIVES.length]!;
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]!;
  return `${adjective}-${noun}`;
}
