import { describe, expect, it, vi } from "vitest";
import { parseLooseJson } from "../../../../home/apps/mail/src/agent/json";
import { generateJson } from "../../../../home/apps/mail/src/agent/ai";
import { MailAgentError } from "../../../../home/apps/mail/src/agent/errors";
import { MAX_PROMPT_CHARS } from "../../../../home/apps/mail/src/agent/limits";

const isSummary = (value: unknown): { summary: string } | null =>
  typeof value === "object" && value !== null && typeof (value as { summary?: unknown }).summary === "string"
    ? { summary: (value as { summary: string }).summary }
    : null;

describe("parseLooseJson", () => {
  it("parses clean JSON", () => {
    expect(parseLooseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("extracts JSON from code fences and surrounding prose", () => {
    expect(parseLooseJson('Sure! Here it is:\n```json\n{"a": [1, 2]}\n```\nAnything else?')).toEqual({ ok: true, value: { a: [1, 2] } });
  });

  it("repairs trailing commas, smart quotes and raw newlines in strings", () => {
    const result = parseLooseJson('{“summary”: “line one\nline two”, "items": [1, 2,],}');
    expect(result).toEqual({ ok: true, value: { summary: "line one\nline two", items: [1, 2] } });
  });

  it("closes a reply cut off mid-way", () => {
    expect(parseLooseJson('{"items": [{"a": "x"}, {"a": "y')).toEqual({ ok: true, value: { items: [{ a: "x" }, { a: "y" }] } });
  });

  it("does not treat braces inside strings as structure", () => {
    expect(parseLooseJson('{"text": "a } b { c"}')).toEqual({ ok: true, value: { text: "a } b { c" } });
  });

  it("returns a failure for text without JSON", () => {
    expect(parseLooseJson("I cannot help with that.")).toEqual({ ok: false });
    expect(parseLooseJson("")).toEqual({ ok: false });
  });

  it("prefers an array when the reply starts with one", () => {
    expect(parseLooseJson('[{"index": 1}]')).toEqual({ ok: true, value: [{ index: 1 }] });
  });
});

describe("generateJson", () => {
  it("returns the validated value from the first reply", async () => {
    const generate = vi.fn(async () => '{"summary":"ok"}');
    await expect(generateJson({ generate }, "prompt", isSummary, "{summary}")).resolves.toEqual({ summary: "ok" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("runs one repair pass with a bounded prompt when the reply is unusable", async () => {
    const replies = ["x".repeat(70_000), '{"summary":"fixed"}'];
    const generate = vi.fn(async () => replies.shift()!);
    await expect(generateJson({ generate }, "prompt", isSummary, "{summary}")).resolves.toEqual({ summary: "fixed" });
    expect(generate).toHaveBeenCalledTimes(2);
    const repairPrompt = generate.mock.calls[1][0] as string;
    expect(repairPrompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(repairPrompt).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  });

  it("fails with a typed invalid_reply error after the repair pass", async () => {
    const generate = vi.fn(async () => "no json here");
    const error = await generateJson({ generate }, "prompt", isSummary, "{summary}").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailAgentError);
    expect((error as MailAgentError).code).toBe("invalid_reply");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("maps a bridge failure to ai_failed without leaking its text", async () => {
    const generate = vi.fn(async () => {
      throw new Error("provider secret at /home/x");
    });
    const error = await generateJson({ generate }, "prompt", isSummary, "{summary}").catch((e: unknown) => e);
    expect((error as MailAgentError).code).toBe("ai_failed");
    expect((error as MailAgentError).message).not.toContain("/home/x");
  });

  it("refuses a prompt over the limit without calling the bridge", async () => {
    const generate = vi.fn(async () => "{}");
    const error = await generateJson({ generate }, "p".repeat(MAX_PROMPT_CHARS + 1), isSummary, "{summary}").catch((e: unknown) => e);
    expect((error as MailAgentError).code).toBe("prompt_too_large");
    expect(generate).not.toHaveBeenCalled();
  });

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const generate = vi.fn(async () => '{"summary":"ok"}');
    const error = await generateJson({ generate }, "prompt", isSummary, "{summary}", { signal: controller.signal }).catch((e: unknown) => e);
    expect((error as MailAgentError).code).toBe("cancelled");
  });
});
