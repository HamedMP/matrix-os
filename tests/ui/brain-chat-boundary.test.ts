import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BRAIN = resolve(__dirname, "../../packages/ui/src/brain");

/** The brain chat is a Matrix Chat: the Brain app picks which Chat to show and the surface's chat view shows it. */
describe("Brain chat stays on Matrix Chat", () => {
  const files = readdirSync(BRAIN).filter((name) => /\.tsx?$/.test(name));
  const sources = files.map((name) => ({ name, text: readFileSync(join(BRAIN, name), "utf8") }));

  it("opens no stream or request of its own and draws no transcript or composer", () => {
    expect(files).toContain("BrainChat.tsx");
    for (const { name, text } of sources) {
      for (const banned of [/\bEventSource\b/, /\bWebSocket\b/, /\bfetch\(/, /<textarea/, /\/api\/chats/, /\/api\/chat-agents/]) {
        expect(`${name}: ${banned.test(text)}`).toBe(`${name}: false`);
      }
    }
  });

  it("reaches threads only through the shared Chat Agents client and the host slot", () => {
    const chat = sources.find((source) => source.name === "BrainChat.tsx")!.text;
    expect(chat).toContain("bots.threads.create(");
    expect(chat).toContain("host.render(");
    const threads = sources.find((source) => source.name === "use-brain-threads.ts")!.text;
    expect(threads).toContain("bots.threads.list(");
  });
});
