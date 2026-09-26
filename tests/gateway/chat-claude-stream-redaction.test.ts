import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { createAssistantTextStreamProjector } from "../../packages/gateway/src/chat/safe-activity-projection.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

class FakeStream extends EventEmitter {}

function child(lines: string[], options: { exitCode?: number; afterLines?: () => void } = {}) {
  const process = new EventEmitter() as EventEmitter & {
    stdout: FakeStream;
    stderr: FakeStream;
    kill: ReturnType<typeof vi.fn>;
  };
  process.stdout = new FakeStream();
  process.stderr = new FakeStream();
  process.kill = vi.fn(() => {
    queueMicrotask(() => process.emit("exit", null, "SIGTERM"));
    return true;
  });
  Object.assign(process, {
    stdin: { write: (_chunk: string, callback?: (error?: Error | null) => void) => { callback?.(); return true; } },
  });
  let next = 0;
  const emitNext = () => {
    if (next === lines.length) {
      if (options.afterLines) options.afterLines();
      else process.emit("exit", options.exitCode ?? 0, null);
      return;
    }
    process.stdout.emit("data", Buffer.from(`${lines[next++]!}\n`));
    queueMicrotask(emitNext);
  };
  queueMicrotask(emitNext);
  return process;
}

const input = {
  owner: { type: "personal" as const, ownerId: "owner_claude" },
  chatId: "chat_claude",
  turnId: "cturn_claude",
  runId: "run_claude",
  prompt: "Find the documentation",
  parts: [{ type: "text" as const, text: "Find the documentation" }],
  selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5", options: [] },
  interactionMode: "default",
  permissionMode: "auto_accept_edits",
  executionRoot: "/safe/project",
  signal: new AbortController().signal,
};

function streamLines(chunks: string[], options: { stop?: boolean; result?: boolean } = {}): string[] {
  return [
    JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } }),
    ...chunks.map((text) => JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    })),
    ...(options.stop === false ? [] : [JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 } })]),
    ...(options.result === false ? [] : [JSON.stringify({ type: "result", subtype: "success", result: chunks.join(""), session_id: "claude_stream_redaction" })]),
  ];
}

function separateTextBlocksWithChunks(parts: string[][]): string[] {
  return [
    ...parts.flatMap((chunks, index) => [
      JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text" } } }),
      ...chunks.map((text) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } })),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index } }),
    ]),
    JSON.stringify({ type: "result", subtype: "success", result: parts.flat().join(""), session_id: "claude_block_redaction" }),
  ];
}

function separateTextBlocks(parts: string[]): string[] {
  return separateTextBlocksWithChunks(parts.map((part) => [part]));
}

async function runLines(
  lines: string[],
  options: { exitCode?: number; afterLines?: () => void; signal?: AbortSignal } = {},
): Promise<CanonicalProviderRunEvent[]> {
  const adapter = createClaudeChatProviderAdapter({
    homePath: "/home/matrix/home",
    spawnFn: vi.fn(() => child(lines, options)),
  });
  const events: CanonicalProviderRunEvent[] = [];
  for await (const event of adapter.start({ ...input, signal: options.signal ?? input.signal })) events.push(event);
  return events;
}

async function streamedAssistantDeltas(chunks: string[]): Promise<string[]> {
  const events = await runLines(streamLines(chunks));
  const deltas: string[] = [];
  for (const event of events) {
    if (event.type === "assistant.delta") deltas.push(event.delta);
  }
  return deltas;
}

// The canonical orchestrator appends each delta to its provider message ID.
function assembledAssistantMessages(events: CanonicalProviderRunEvent[]): Map<string, string> {
  const messages = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "assistant.delta") continue;
    const id = event.messageId ?? "default";
    messages.set(id, (messages.get(id) ?? "") + event.delta);
  }
  return messages;
}

describe("Claude streamed assistant text redaction", () => {
  it("preserves a public HTTPS documentation URL split at path boundaries", async () => {
    const deltas = await streamedAssistantDeltas([
      "Title: What is Azure Functions? URL: https://learn.microsoft.com/azure",
      "/azure-functions",
      "/functions-overview",
    ]);

    expect(deltas.join("")).toBe(
      "Title: What is Azure Functions? URL: https://learn.microsoft.com/azure/azure-functions/functions-overview",
    );
  });

  it.each([
    {
      name: "absolute private path",
      chunks: ["Inspect /private/", "secret/file", " now."],
      expected: "Inspect [redacted path] now.",
      forbidden: "secret/file",
    },
    {
      name: "Bearer credential",
      chunks: ["Bearer ", "fixture-secret-token", " now."],
      expected: "Bearer [redacted] now.",
      forbidden: "fixture-secret-token",
    },
    {
      name: "assigned credential",
      chunks: ["ACCESS_TOKEN=", "fixture-secret-value", " now."],
      expected: "[redacted credential] now.",
      forbidden: "fixture-secret-value",
    },
  ])("never publishes any part of a split $name", async ({ chunks, expected, forbidden }) => {
    const deltas = await streamedAssistantDeltas(chunks);

    for (const delta of deltas) expect(delta).not.toContain(forbidden);
    expect(deltas.join("")).toBe(expected);
  });

  it.each([
    {
      name: "public documentation URL",
      value: "URL: https://learn.microsoft.com/azure/azure-functions/functions-overview",
      expected: "URL: https://learn.microsoft.com/azure/azure-functions/functions-overview",
    },
    {
      name: "private absolute path",
      value: "Inspect /private/secret/file now.",
      expected: "Inspect [redacted path] now.",
    },
    {
      name: "Bearer credential",
      value: "Bearer fixture-secret-token now.",
      expected: "Bearer [redacted] now.",
    },
    {
      name: "spaced credential assignment",
      value: "ACCESS_TOKEN = fixture-secret-value now.",
      expected: "[redacted credential] now.",
    },
  ])("projects $name identically at every two-part split and sampled multi-part splits", ({ value, expected }) => {
    const project = (chunks: string[]) => {
      const projector = createAssistantTextStreamProjector({ homePath: "/home/matrix/home" });
      return chunks.map((chunk) => projector.push(chunk)).join("") + projector.flush();
    };

    for (let split = 0; split <= value.length; split++) {
      expect(project([value.slice(0, split), "", value.slice(split)])).toBe(expected);
    }
    let seed = 17;
    for (let sample = 0; sample < 16; sample++) {
      const chunks: string[] = [];
      for (let offset = 0; offset < value.length;) {
        seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
        const end = Math.min(value.length, offset + 1 + seed % 7);
        chunks.push(value.slice(offset, end));
        offset = end;
      }
      expect(project(chunks)).toBe(expected);
    }
  });

  it("handles empty chunks and newlines without releasing a split credential", () => {
    const projector = createAssistantTextStreamProjector({ homePath: "/home/matrix/home" });
    const output = ["Bearer", "", "\n", "fixture-secret-token", "\n", "Done."]
      .map((chunk) => projector.push(chunk)).join("") + projector.flush();
    expect(output).toBe("Bearer [redacted]\nDone.");
  });

  it("emits ordinary completed words before stream completion", () => {
    const projector = createAssistantTextStreamProjector({ homePath: "/home/matrix/home" });
    expect(projector.push("Hello world ")).toBe("Hello world ");
    expect(projector.push("again")).toBe("");
    expect(projector.flush()).toBe("again");
  });

  it("streams ordinary Chinese prose without spaces or false overflow redaction", () => {
    const projector = createAssistantTextStreamProjector({ homePath: "/home/matrix/home" });
    const sentence = "这是普通中文回答。";
    const first = projector.push(sentence);
    const rest = projector.push(sentence.repeat(299)) + projector.flush();
    expect(first.length).toBeGreaterThan(0);
    expect(first + rest).toBe(sentence.repeat(300));
  });

  it("keeps a long unspaced Chinese Claude answer intact across streamed deltas", async () => {
    const sentence = "这是普通中文回答。";
    const deltas = await streamedAssistantDeltas(Array.from({ length: 3 }, () => sentence.repeat(100)));
    expect(deltas.join("")).toBe(sentence.repeat(300));
    expect(deltas[0]?.length).toBeGreaterThan(0);
  });

  it("does not release Chinese text inside a private path or assigned credential", () => {
    const path = createAssistantTextStreamProjector({ homePath: "/home/matrix/home" });
    const pathDeltas = [path.push("查看 /private/"), path.push("秘密文件"), path.flush()];
    expect(pathDeltas[1]).toBe("");
    expect(pathDeltas.join("")).toBe("查看 [redacted path]");

    const credential = createAssistantTextStreamProjector({ homePath: "/home/matrix/home" });
    const credentialDeltas = [credential.push("ACCESS_TOKEN="), credential.push("机密值"), credential.flush()];
    expect(credentialDeltas[1]).toBe("");
    expect(credentialDeltas.join("")).toBe("[redacted credential]");
  });

  it("keeps a spaced execution-root path intact until the complete root can be projected", () => {
    const projector = createAssistantTextStreamProjector({
      homePath: "/home/matrix/home",
      executionRoot: "/safe/Team Project",
    });
    const deltas = [projector.push("Inspect /safe/Team "), projector.push("Project/file now."), projector.flush()];
    for (const delta of deltas) expect(delta).not.toContain("Project/file");
    expect(deltas.join("")).toBe("Inspect file now.");
  });

  it.each([
    {
      name: "Bearer credential",
      parts: ["Bearer ", "fixture-secret-token"],
      expected: "Bearer [redacted]",
      forbidden: "fixture-secret-token",
    },
    {
      name: "assigned credential",
      parts: ["ACCESS_TOKEN=", "fixture-secret-value"],
      expected: "[redacted credential]",
      forbidden: "fixture-secret-value",
    },
    {
      name: "Bearer keyword split",
      parts: ["Bear", "er fixture-secret-token"],
      expected: "Bearer [redacted]",
      forbidden: "fixture-secret-token",
    },
    {
      name: "assignment keyword split",
      parts: ["ACCESS_TO", "KEN=fixture-secret-value"],
      expected: "[redacted credential]",
      forbidden: "fixture-secret-value",
    },
    {
      name: "private path",
      parts: ["Inspect /private/", "secret/file"],
      expected: "Inspect [redacted path]",
      forbidden: "secret/file",
    },
    {
      name: "public URL",
      parts: ["URL: https://learn.microsoft.com/azure", "/azure-functions"],
      expected: "URL: https://learn.microsoft.com/azure/azure-functions",
      forbidden: "[redacted path]",
    },
  ])("keeps a split $name safe across text-block boundaries", async ({ parts, expected, forbidden }) => {
    const events = await runLines(separateTextBlocks(parts));
    const deltas = events.filter((event) => event.type === "assistant.delta").map((event) => event.delta);
    for (const delta of deltas) expect(delta).not.toContain(forbidden);
    expect(deltas.join("")).toBe(expected);
  });

  it("preserves a relative path split across text blocks under its originating message", async () => {
    const events = await runLines(separateTextBlocks(["docs", "/guide next"]));
    const deltas = events.filter((event) => event.type === "assistant.delta");
    expect(deltas.map((event) => event.delta).join("")).toBe("docs/guide next");
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "docs/guide "],
      ["claude_text_1", "next"],
    ]);
  });

  it.each([
    ["第一段中文", "第二段中文", "第一段中文", "第二段中文"],
    ["first.", "第二段中文", "first.", "第二段中文"],
    ["Hello", "world", "Hello", "world"],
  ])("keeps ordinary adjacent text blocks in distinct durable messages (%s)", async (first, second, expectedFirst, expectedSecond) => {
    const events = await runLines(separateTextBlocks([first, second]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", expectedFirst],
      ["claude_text_1", expectedSecond],
    ]);
  });

  it.each([
    ["Bearer fixture-secret-token done", "Bearer [redacted] done", "fixture-secret-token"],
    ["ACCESS_TOKEN=fixture-secret-value done", "[redacted credential] done", "fixture-secret-value"],
  ])("does not concatenate an unrelated first block with a split new-block credential (%s)", async (second, expected, forbidden) => {
    for (let split = 1; split < second.length; split++) {
      const events = await runLines(separateTextBlocksWithChunks([["Hello"], [second.slice(0, split), second.slice(split)]]));
      const deltas = events.filter((event) => event.type === "assistant.delta");
      for (const event of deltas) expect(event.delta).not.toContain(forbidden);
      expect([...assembledAssistantMessages(events)]).toEqual([
        ["claude_text_0", "Hello"],
        ["claude_text_1", expected],
      ]);
    }
  });

  it.each([
    ["Bear", "er fixture-secret-token done", "Bearer [redacted] ", "fixture-secret-token"],
    ["ACCESS_TO", "KEN=fixture-secret-value done", "[redacted credential] ", "fixture-secret-value"],
  ])("preserves a new credential prefix through a third text block (%s)", async (start, continuation, expected, forbidden) => {
    const events = await runLines(separateTextBlocks(["Hello", start, continuation]));
    for (const event of events) {
      if (event.type === "assistant.delta") expect(event.delta).not.toContain(forbidden);
    }
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "Hello"],
      ["claude_text_1", expected],
      ["claude_text_2", "done"],
    ]);
  });

  it.each([
    ["c", "c"],
    ["Bear", "Bear"],
    ["Bearer ", "Bearer "],
    ["ACCESS_TOKEN=", "ACCESS_TOKEN="],
    ["/private/file", "[redacted path]"],
    ["https://example.test/x", "https://example.test/x"],
    ["docs", "docs"],
    ["文", "文"],
  ])("recognizes a new-block credential after retained %s context at every prefix split", async (first, safeFirst) => {
    for (const [second, prefix, marker, forbidden] of [
      ["Bearer fixture-secret-token done", "Bearer", "Bearer [redacted]", "fixture-secret-token"],
      ["ACCESS_TOKEN=fixture-secret-value done", "ACCESS_TOKEN", "[redacted credential]", "fixture-secret-value"],
    ]) {
      for (let split = 1; split <= prefix.length; split++) {
        const events = await runLines(separateTextBlocksWithChunks([[first], [second.slice(0, split), second.slice(split)]]));
        for (const event of events) {
          if (event.type === "assistant.delta") expect(event.delta).not.toContain(forbidden);
        }
        const messages = assembledAssistantMessages(events);
        expect(messages.get("claude_text_0")).toBeDefined();
        expect(messages.get("claude_text_0")).not.toContain(forbidden);
        expect(messages.get("claude_text_1")).toContain(marker);
        expect([...messages.values()].join("")).not.toContain(forbidden);
        if (!first.includes("Bearer") && !first.includes("TOKEN=")) {
          expect(messages.get("claude_text_0")).toBe(safeFirst);
        }
      }
    }
  });

  it.each([
    "apiKey", "API_KEY", "api-key", "apiToken", "API_TOKEN", "api-token",
    "accessToken", "ACCESS_TOKEN", "access-token", "secret", "PASSWORD", "credential",
  ])("recognizes the %s assignment variant as an independent credential", async (keyword) => {
    const second = `${keyword} = fixture-secret-value done`;
    for (let split = 1; split <= keyword.length + 2; split++) {
      const events = await runLines(separateTextBlocksWithChunks([["c"], [second.slice(0, split), second.slice(split)]]));
      const messages = assembledAssistantMessages(events);
      expect(messages.get("claude_text_0")).toBe("c");
      expect(messages.get("claude_text_1")).toBe("[redacted credential] done");
      expect([...messages.values()].join("")).not.toContain("fixture-secret-value");
      for (const event of events) {
        if (event.type === "assistant.delta") expect(event.delta).not.toContain("fixture-secret-value");
      }
    }
  });

  it("recognizes a lowercase Bearer prefix across a new-block split", async () => {
    const events = await runLines(separateTextBlocksWithChunks([["c"], ["bEa", "ReR fixture-secret-token done"]]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "c"],
      ["claude_text_1", "Bearer [redacted] done"],
    ]);
  });

  it("fails closed on a new-block credential prefix left unfinished at success", async () => {
    const events = await runLines(separateTextBlocks(["/private/file", "Be"]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "[redacted path]"],
      ["claude_text_1", "[redacted]"],
    ]);
  });

  it("marks each unresolved nested prefix under its own message at success", async () => {
    const events = await runLines(separateTextBlocks(["/private/file", "Be", "Be"]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "[redacted path]"],
      ["claude_text_1", "[redacted]"],
      ["claude_text_2", "[redacted]"],
    ]);
  });

  it.each([
    ["Bearer ", "Bearer [redacted]"],
    ["ACCESS_TOKEN=", "[redacted credential]"],
  ])("does not flush a dangling %s prefix raw at successful completion", async (prefix, expected) => {
    const events = await runLines(separateTextBlocks(["Hello", prefix]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "Hello"],
      ["claude_text_1", expected],
    ]);
  });

  it.each(["secret", "password", "credential"])("keeps an ordinary sentence ending in %s", async (word) => {
    const events = await runLines(separateTextBlocks([`This is a ${word}`]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", `This is a ${word}`],
    ]);
  });

  it.each([
    ["Note:Bearer ", "Note:Bearer [redacted]"],
    ["Note:ACCESS_TOKEN=", "Note:[redacted credential]"],
  ])("keeps punctuation before a dangling credential prefix (%s)", (source, expected) => {
    const projector = createAssistantTextStreamProjector({ homePath: "/home/matrix/home" });
    expect(projector.push(source) + projector.flush()).toBe(expected);
  });

  it.each([
    ["c", "Be", "arer fixture-secret-token done", "c", "Bearer [redacted] ", "fixture-secret-token"],
    ["/private/file", "ACCESS_TO", "KEN=fixture-secret-value done", "[redacted path]", "[redacted credential] ", "fixture-secret-value"],
  ])("attributes a standalone credential prefix across a third text block (%s)", async (first, start, end, safeFirst, safeSecond, forbidden) => {
    const events = await runLines(separateTextBlocks([first, start, end]));
    for (const event of events) {
      if (event.type === "assistant.delta") expect(event.delta).not.toContain(forbidden);
    }
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", safeFirst],
      ["claude_text_1", safeSecond],
      ["claude_text_2", "done"],
    ]);
  });

  it.each([
    ["c", "Be", "Bearer fixture-secret-token done", "c", "Bearer [redacted] done", "fixture-secret-token"],
    ["/private/file", "Be", "Bearer fixture-secret-token done", "[redacted path]", "Bearer [redacted] done", "fixture-secret-token"],
    ["c", "ACCESS_TO", "ACCESS_TOKEN=fixture-secret-value done", "c", "[redacted credential] done", "fixture-secret-value"],
    ["/private/file", "ACCESS_TO", "ACCESS_TOKEN=fixture-secret-value done", "[redacted path]", "[redacted credential] done", "fixture-secret-value"],
  ])("keeps a third-block standalone credential separate from an unfinished prior prefix (%s, %s)", async (
    first, ambiguous, independent, expectedFirst, expectedThird, forbidden,
  ) => {
    const markerIndex = independent.includes("=") ? independent.indexOf("=") : independent.indexOf(" ");
    for (let split = 1; split <= markerIndex + 1; split++) {
      const events = await runLines(separateTextBlocksWithChunks([
        [first], [ambiguous], [independent.slice(0, split), independent.slice(split)],
      ]));
      for (const event of events) {
        if (event.type === "assistant.delta") expect(event.delta).not.toContain(forbidden);
      }
      expect([...assembledAssistantMessages(events)]).toEqual([
        ["claude_text_0", expectedFirst],
        ["claude_text_1", "[redacted]"],
        ["claude_text_2", expectedThird],
      ]);
    }
  });

  it("keeps a true third-block Bearer keyword continuation on its original message", async () => {
    const events = await runLines(separateTextBlocks(["c", "Be", "arer fixture-secret-token done"]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "c"],
      ["claude_text_1", "Bearer [redacted] "],
      ["claude_text_2", "done"],
    ]);
  });

  it.each([
    ["Bearer fixture-secret-token done", "Bearer [redacted] done", "fixture-secret-token"],
    ["aCcEsS_ToKeN=fixture-secret-value done", "[redacted credential] done", "fixture-secret-value"],
  ])("keeps a nested four-block credential restart separate (%s)", async (independent, expected, forbidden) => {
    const events = await runLines(separateTextBlocks(["/private/file", "Be", "Be", independent]));
    for (const event of events) {
      if (event.type === "assistant.delta") expect(event.delta).not.toContain(forbidden);
    }
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "[redacted path]"],
      ["claude_text_1", "[redacted]"],
      ["claude_text_2", "[redacted]"],
      ["claude_text_3", expected],
    ]);
  });

  it("recognizes a credential restarting across the last two of five text blocks", async () => {
    const events = await runLines(separateTextBlocks(["c", "Be", "Be", "Be", "arer fixture-secret-token done"]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "c"],
      ["claude_text_1", "[redacted]"],
      ["claude_text_2", "[redacted]"],
      ["claude_text_3", "Bearer [redacted] "],
      ["claude_text_4", "done"],
    ]);
  });

  it("preserves a true Bearer keyword continuation over four text blocks", async () => {
    const events = await runLines(separateTextBlocks(["c", "B", "ea", "rer fixture-secret-token done"]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "c"],
      ["claude_text_1", "Bearer [redacted] "],
      ["claude_text_3", "done"],
    ]);
  });

  it.each([
    ["docs", "/gu", "ide", " next", "docs/guide "],
    ["https:", "/", "/example.test", "/guide next", "https://example.test/guide "],
  ])("preserves a four-block path or URL continuation and later text IDs (%s)", async (first, second, third, fourth, expected) => {
    const events = await runLines(separateTextBlocks([first, second, third, fourth]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", expected],
      ["claude_text_3", "next"],
    ]);
  });

  it("drops nested unresolved prefixes before a steered continuation starts", async () => {
    let spawned = 0;
    const initialLines = [
      JSON.stringify({ type: "system", session_id: "claude_probe_steer" }),
      ...separateTextBlocks(["Visible /private/file", "Be", "Be"]).slice(0, -1),
    ];
    const adapter = createClaudeChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn: vi.fn(() => ++spawned === 1
        ? child(initialLines, { afterLines: () => {
          void adapter.steer({ owner: input.owner, chatId: input.chatId, runId: input.runId, prompt: "Continue safely" });
        } })
        : child(streamLines(["Safe fresh text"]))),
    });
    const events: CanonicalProviderRunEvent[] = [];
    for await (const event of adapter.start(input)) events.push(event);
    expect(spawned).toBe(2);
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.delta).join(""))
      .toBe("Visible Safe fresh text");
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
  });

  it("drops an unresolved new-block credential prefix when the CLI fails", async () => {
    const lines = separateTextBlocks(["Visible /private/file", "Be"]).slice(0, -1);
    const events = await runLines(lines, { exitCode: 1 });
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.delta).join(""))
      .toBe("Visible ");
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
  });

  it("drops an unresolved new-block credential prefix on abort", async () => {
    const controller = new AbortController();
    const lines = separateTextBlocks(["Visible /private/file", "Be"]).slice(0, -1);
    const events = await runLines(lines, { signal: controller.signal, afterLines: () => controller.abort() });
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.delta).join(""))
      .toBe("Visible ");
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
  });

  it("drops all nested unresolved prefixes on abort", async () => {
    const controller = new AbortController();
    const lines = separateTextBlocks(["Visible /private/file", "Be", "Be"]).slice(0, -1);
    const events = await runLines(lines, { signal: controller.signal, afterLines: () => controller.abort() });
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.delta).join(""))
      .toBe("Visible ");
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
  });

  it("caps an undecidable new-block assignment prefix without publishing later text", async () => {
    const events = await runLines(separateTextBlocks(["Bearer ", `ACCESS_TOKEN${" ".repeat(80)}=fixture-secret-value done`]));
    const messages = assembledAssistantMessages(events);
    expect(messages.get("claude_text_0")).toBe("Bearer [redacted]");
    expect(messages.get("claude_text_1")).toBe("[redacted]");
    expect([...messages.values()].join("")).not.toContain("fixture-secret-value");
  });

  it("keeps nested prefix overflow bounded to one marker at the first unresolved origin", async () => {
    const events = await runLines(separateTextBlocks(["c", "Be", "Be", `API_KEY${" ".repeat(80)}=fixture-secret-value done`]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "c"],
      ["claude_text_1", "[redacted]"],
    ]);
  });

  it.each(["secretary", "Bearerish"])("keeps a keyword-like %s token inside a prior Bearer context", async (token) => {
    const events = await runLines(separateTextBlocks(["Bearer ", `${token} done`]));
    for (const event of events) {
      if (event.type === "assistant.delta") expect(event.delta).not.toContain(token);
    }
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "Bearer [redacted] "],
      ["claude_text_1", "done"],
    ]);
  });

  it("does not publish an assignment keyword used as a prior Bearer token", async () => {
    const events = await runLines(separateTextBlocks(["Bearer ", "ACCESS_TOKEN done"]));
    const deltas = events.filter((event) => event.type === "assistant.delta");
    for (const event of deltas) expect(event.delta).not.toContain("ACCESS_TOKEN");
    // The suffix stays withheld because ACCESS_TOKEN may still be followed by
    // an equals sign in a later chunk; end-of-Run resolves it safely.
    expect(deltas.map((event) => event.delta).join("")).toBe("Bearer [redacted] done");
  });

  it("keeps a credential continuation with its originating message ID", async () => {
    const events = await runLines(separateTextBlocks(["Bearer ", "fixture-secret-token done"]));
    const deltas = events.filter((event) => event.type === "assistant.delta");
    expect(deltas.map((event) => event.delta).join("")).toBe("Bearer [redacted] done");
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "Bearer [redacted] "],
      ["claude_text_1", "done"],
    ]);
  });

  it.each([
    ["URL: https:", "//learn.microsoft.com/azure"],
    ["URL: https:/", "/learn.microsoft.com/azure"],
  ])("does not detach a public URL when its scheme is split between text blocks (%s)", async (first, second) => {
    const events = await runLines(separateTextBlocks([first, second]));
    const deltas = events.filter((event) => event.type === "assistant.delta");
    expect(deltas.map((event) => event.delta).join("")).toBe("URL: https://learn.microsoft.com/azure");
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "URL: https://learn.microsoft.com/azure"],
    ]);
  });

  it.each(["/指南", "/guide"])("preserves a Chinese relative path ending %s across chunks", (suffix) => {
    const projector = createAssistantTextStreamProjector({ homePath: "/home/matrix/home" });
    expect(projector.push("文档") + projector.push(suffix) + projector.flush()).toBe(`文档${suffix}`);
  });

  it("keeps a Chinese relative path continuation on its original message", async () => {
    const events = await runLines(separateTextBlocks(["文档", "/guide next"]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "文档/guide "],
      ["claude_text_1", "next"],
    ]);
  });

  it("keeps a bounded overflow marker with the first block and new text with the second", async () => {
    const events = await runLines(separateTextBlocks(["x".repeat(3_000), "more safe"]));
    const deltas = events.filter((event) => event.type === "assistant.delta");
    expect(deltas.map((event) => event.delta).join("")).toBe("[redacted] safe");
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", "[redacted] "],
      ["claude_text_1", "safe"],
    ]);
  });

  it.each([
    { value: "Bearer fixture-secret-token", expected: "Bearer [redacted]" },
    { value: "ACCESS_TOKEN=fixture-secret-value", expected: "[redacted credential]" },
    { value: "Inspect /private/secret/file", expected: "Inspect [redacted path]" },
    { value: "URL: https://learn.microsoft.com/azure/azure-functions", expected: "URL: https://learn.microsoft.com/azure/azure-functions" },
  ])("keeps every text-block split of $value equivalent to a full safe projection", ({ value, expected }) => {
    for (let split = 1; split < value.length; split++) {
      const projector = createAssistantTextStreamProjector({ homePath: "/home/matrix/home" });
      const projected = projector.push(value.slice(0, split)) + projector.flushBoundary()
        + projector.push(value.slice(split)) + projector.flush();
      expect(projected).toBe(expected);
    }
  });

  it("replaces an overlong token once and drops its remainder until whitespace", () => {
    const projector = createAssistantTextStreamProjector({ homePath: "/home/matrix/home" });
    expect(projector.push("x".repeat(3_000) + " safe ")).toBe("[redacted] safe ");
    expect(projector.flush()).toBe("");
  });

  it("discards an incomplete private token on cancellation", () => {
    const projector = createAssistantTextStreamProjector({ homePath: "/home/matrix/home" });
    expect(projector.push("Visible /private/secret")).toBe("Visible ");
    projector.discard();
    expect(projector.flush()).toBe("");
  });

  it("flushes a public URL at successful Run end without a text block stop or duplicate result", async () => {
    const events = await runLines(streamLines([
      "URL: https://learn.microsoft.com/azure",
      "/azure-functions/functions-overview",
    ], { stop: false }));
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.delta).join(""))
      .toBe("URL: https://learn.microsoft.com/azure/azure-functions/functions-overview");
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  });

  it("drops an unfinished private token when the CLI fails", async () => {
    const events = await runLines(streamLines(["Visible /private/secret"], { stop: false, result: false }), { exitCode: 1 });
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.delta).join(""))
      .toBe("Visible ");
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
  });

  it("drops an unfinished private token when the Run is aborted", async () => {
    const controller = new AbortController();
    const events = await runLines(streamLines(["Visible /private/secret"], { stop: false, result: false }), {
      signal: controller.signal,
      afterLines: () => controller.abort(),
    });
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.delta).join(""))
      .toBe("Visible ");
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
  });
});
