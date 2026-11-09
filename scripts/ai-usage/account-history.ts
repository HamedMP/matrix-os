import { readFile, stat } from "node:fs/promises";
/** An account export supplies activity, not provider token/billing counters. Text never leaves this reader. */
export async function readClaudeAccountHistory(path: string) {
  const st = await stat(path);
  if (st.size > 128 * 1024 * 1024)
    throw new RangeError("Account export needs streaming migration");
  const conversations: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(conversations)) throw new Error("Invalid account export");
  const years = new Map<
    string,
    { year: string; conversations: number; messages: number }
  >(); // Maximum 200 calendar years; throw on overflow.
  let first: string | null = null,
    last: string | null = null,
    messages = 0;
  function year(date: unknown) {
    if (typeof date !== "string" || !Number.isFinite(Date.parse(date)))
      return null;
    const time = new Date(date).toISOString();
    if (!first || time < first) first = time;
    if (!last || time > last) last = time;
    const key = time.slice(0, 4);
    let value = years.get(key);
    if (!value) {
      if (years.size >= 200) throw new RangeError("Account history year limit");
      value = { year: key, conversations: 0, messages: 0 };
      years.set(key, value);
    }
    return value;
  }
  for (const c of conversations) {
    if (!c || typeof c !== "object")
      throw new Error("Invalid account conversation");
    const bucket = year(c.created_at);
    if (bucket) bucket.conversations++;
    if (!Array.isArray(c.chat_messages))
      throw new Error("Invalid account messages");
    for (const message of c.chat_messages) {
      messages++;
      const value = year(message.created_at);
      if (value) value.messages++;
    }
  }
  return {
    provider: "Claude",
    conversations: conversations.length,
    messages,
    first,
    last,
    years: [...years.values()].sort((a, b) => a.year.localeCompare(b.year)),
    tokenCountersAvailable: false as const,
  };
}
