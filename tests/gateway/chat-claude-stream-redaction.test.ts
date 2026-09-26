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

function separateTextBlocks(parts: string[]): string[] {
  return [
    ...parts.flatMap((text, index) => [
      JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text" } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index } }),
    ]),
    JSON.stringify({ type: "result", subtype: "success", result: parts.join(""), session_id: "claude_block_redaction" }),
  ];
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
  ])("keeps ordinary adjacent text blocks in distinct durable messages (%s)", async (first, second, expectedFirst, expectedSecond) => {
    const events = await runLines(separateTextBlocks([first, second]));
    expect([...assembledAssistantMessages(events)]).toEqual([
      ["claude_text_0", expectedFirst],
      ["claude_text_1", expectedSecond],
    ]);
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
