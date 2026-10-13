import type { AoedeTranscript } from "@matrix-os/contracts";

export function createTranscriptBuffer(seed: AoedeTranscript[] = []) {
  let turns = seed.map((t) => ({ ...t, historical: true }));
  const seen = new Set<string>();
  function trim() {
    turns = turns.slice(-24);
    let remaining = 16_000;
    for (let i = turns.length - 1; i >= 0; i--) {
      turns[i].text = remaining > 0 ? turns[i].text.slice(-remaining) : "";
      remaining -= turns[i].text.length;
    }
    turns = turns.filter((t) => t.text.length > 0);
  }
  trim();
  return {
    add(role: AoedeTranscript["role"], delta: string, offset: number, eventId: string) {
      if (seen.has(eventId)) return;
      if (seen.size >= 512) seen.delete(seen.values().next().value!);
      seen.add(eventId);
      const last = turns.at(-1);
      if (last?.role === role && !last.historical && offset >= last.offset && offset - last.offset <= 2_000) {
        last.text += delta; last.offset = offset;
      } else turns.push({ role, text: delta, offset, historical: false });
      trim();
    },
    snapshot(offset = Infinity) {
      return turns.filter((t) => t.historical || t.offset <= offset + 500)
        .map(({ role, text, offset }) => ({ role, text, offset }));
    },
    startup() {
      // Conservative byte budget stays below the provider history token cap even for non-English text.
      let bytes = 6_000;
      const history: AoedeTranscript[] = [];
      for (const turn of turns.slice(-12).reverse()) {
        const chars = [...turn.text]; let start = chars.length;
        while (start > 0 && Buffer.byteLength(chars[start - 1]) <= bytes) {
          bytes -= Buffer.byteLength(chars[--start]);
        }
        const text = chars.slice(start).join("");
        if (text) history.unshift({ role: turn.role, text, offset: turn.offset });
        if (start > 0) break;
      }
      return history;
    },
    clear() { turns = []; seen.clear(); },
  };
}
