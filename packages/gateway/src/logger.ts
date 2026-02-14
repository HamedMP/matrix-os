import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_PROMPT_LENGTH = 500;

export interface InteractionInput {
  source: string;
  sessionId: string;
  prompt: string;
  toolsUsed: string[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  result: string;
}

export interface InteractionEntry extends InteractionInput {
  timestamp: string;
}

export interface InteractionLogger {
  log(input: InteractionInput): void;
  query(filter: { date: string; source?: string }): InteractionEntry[];
  totalCost(date: string): number;
}

function logPath(homePath: string, date: string): string {
  return join(homePath, "system", "logs", `${date}.jsonl`);
}

function truncatePrompt(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_LENGTH) return prompt;
  return prompt.slice(0, MAX_PROMPT_LENGTH) + "...";
}

export function createInteractionLogger(homePath: string): InteractionLogger {
  function readEntries(date: string): InteractionEntry[] {
    const path = logPath(homePath, date);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as InteractionEntry);
  }

  return {
    log(input: InteractionInput) {
      const entry: InteractionEntry = {
        ...input,
        prompt: truncatePrompt(input.prompt),
        timestamp: new Date().toISOString(),
      };

      const today = new Date().toISOString().slice(0, 10);
      const path = logPath(homePath, today);
      appendFileSync(path, JSON.stringify(entry) + "\n");
    },

    query(filter: { date: string; source?: string }): InteractionEntry[] {
      let entries = readEntries(filter.date);
      if (filter.source) {
        entries = entries.filter((e) => e.source === filter.source);
      }
      return entries;
    },

    totalCost(date: string): number {
      const entries = readEntries(date);
      return entries.reduce((sum, e) => sum + e.costUsd, 0);
    },
  };
}
