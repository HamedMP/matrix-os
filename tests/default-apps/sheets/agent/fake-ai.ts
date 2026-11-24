import type { SheetsAi } from "../../../../home/apps/sheets/src/agent";

type Reply = string | Error | ((prompt: string) => string | Promise<string>);

/** A model stand-in: records every prompt and answers from a queue. */
export class FakeAi implements SheetsAi {
  readonly prompts: string[] = [];
  private readonly replies: Reply[];

  constructor(...replies: Reply[]) {
    this.replies = replies;
  }

  async generate(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error("no reply queued");
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply(prompt) : reply;
  }
}

export const NOW = () => new Date("2026-11-20T10:00:00Z");

export function envelope(edits: unknown[], summary = "Done."): string {
  return JSON.stringify({ kind: "sheet", edits, summary });
}
