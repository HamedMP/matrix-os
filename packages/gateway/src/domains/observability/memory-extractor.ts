export interface MemoryCandidate {
  content: string;
  category: "fact" | "preference" | "instruction" | "event";
}

interface Message {
  role: string;
  content: string;
}

const PATTERNS: Array<{ pattern: RegExp; category: MemoryCandidate["category"] }> = [
  { pattern: /(?:i prefer|i always want|i like|my preference is)\s+(.+)/i, category: "preference" },
  { pattern: /(?:my name is|i am called|call me)\s+(.+)/i, category: "fact" },
  { pattern: /(?:i live in|i'm from|i'm based in)\s+(.+)/i, category: "fact" },
  { pattern: /(?:remember that|don't forget|keep in mind)\s+(.+)/i, category: "instruction" },
  { pattern: /(?:i work as|my job is|i'm a|my role is)\s+(.+)/i, category: "fact" },
  { pattern: /(?:my timezone is|i'm in)\s+(\w+(?:\s+timezone)?)/i, category: "fact" },
  { pattern: /(?:always|never)\s+(.+)/i, category: "instruction" },
  { pattern: /(?:i usually|i typically|my routine is)\s+(.+)/i, category: "preference" },
  { pattern: /(?:don't|do not|stop|quit)\s+(.+)/i, category: "instruction" },
  { pattern: /(?:my email is|my phone is|my address is)\s+(.+)/i, category: "fact" },
  { pattern: /(?:i use|i'm using|my stack is|my setup is)\s+(.+)/i, category: "fact" },
];

export function extractMemoriesLocal(messages: Message[]): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const { pattern, category } of PATTERNS) {
      const match = msg.content.match(pattern);
      if (match?.[1]) {
        candidates.push({
          content: match[1].trim().replace(/[.!?]$/, ""),
          category,
        });
      }
    }
  }

  return candidates;
}

export function buildExtractionPrompt(messages: Message[]): string {
  const transcript = messages
    .slice(-20)
    .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
    .join("\n");

  return `Extract important facts, preferences, and instructions from this conversation that should be remembered for future sessions. Return JSON array of objects with "content" (string) and "category" (fact|preference|instruction|event).

Only extract genuinely useful long-term information. Skip transient task details.

Conversation:
${transcript}

Return ONLY the JSON array, no other text.`;
}
