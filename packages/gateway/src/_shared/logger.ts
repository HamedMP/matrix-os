import * as fs from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_PROMPT_LENGTH = 500;
const MAX_TOOL_INPUT_LENGTH = 500;
const MAX_STACK_LENGTH = 1000;
const appendFileNow = fs.appendFileSync as (
  path: fs.PathOrFileDescriptor,
  data: string,
) => void;

export interface ToolDetail {
  name: string;
  durationMs: number;
  inputPreview: string;
  status: string;
}

export interface ErrorDetail {
  name: string;
  message: string;
  stack?: string;
}

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
  senderId?: string;
  model?: string;
  agentName?: string;
  tools?: ToolDetail[];
  error?: ErrorDetail;
  batch?: boolean;
  batchId?: string;
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

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

function sanitizeTools(tools?: ToolDetail[]): ToolDetail[] | undefined {
  if (!tools) return undefined;
  return tools.map((t) => ({
    ...t,
    inputPreview: truncate(t.inputPreview, MAX_TOOL_INPUT_LENGTH),
  }));
}

function sanitizeError(error?: ErrorDetail): ErrorDetail | undefined {
  if (!error) return undefined;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack ? truncate(error.stack, MAX_STACK_LENGTH) : undefined,
  };
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
        prompt: truncate(input.prompt, MAX_PROMPT_LENGTH),
        tools: sanitizeTools(input.tools),
        error: sanitizeError(input.error),
        timestamp: new Date().toISOString(),
      };

      const today = new Date().toISOString().slice(0, 10);
      const path = logPath(homePath, today);
      try {
        appendFileNow(path, JSON.stringify(entry) + "\n");
      } catch (err: unknown) {
        console.warn("[logger] Could not append interaction log:", err instanceof Error ? err.message : String(err));
      }
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
