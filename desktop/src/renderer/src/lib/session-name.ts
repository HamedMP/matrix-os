// Friendly display names for sessions. The gateway's zellij session names are
// opaque (matrix-<id>); we derive a stable, readable "adjective-noun-hash"
// label from the attach name deterministically (same name -> same label) so the
// UI avoids opaque IDs while still distinguishing sessions when word pairs
// collide. The real attach name is still used to connect.

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

/** Stable "adjective-noun-hash" label for an attach name (e.g. "brave-otter-1a2b"). */
export function friendlySessionName(attachName: string): string {
  const h = hash32(attachName);
  const adjective = ADJECTIVES[(h & 0xffff) % ADJECTIVES.length]!;
  const noun = NOUNS[(h >>> 16) % NOUNS.length]!;
  const suffix = h.toString(36).padStart(7, "0").slice(-4);
  return `${adjective}-${noun}-${suffix}`;
}
