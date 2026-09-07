import { describe, expect, it } from "vitest";
import { compileElicitation } from "../../packages/gateway/src/coding-agents/codex-elicitation.mjs";

const safeText = (value: string, fallback: string) => value || fallback;
const request = (requestedSchema: unknown) => ({
  id: 42, method: "mcpServer/elicitation/request",
  params: { threadId: "native-thread", turnId: "native-turn", serverName: "connector", mode: "openai/form", message: "Allow this action?", requestedSchema },
});

describe("connector elicitation", () => {
  it.each(["form", "openai/form", "openaiForm"])("supports %s with titled enums and optional fields", (mode) => {
    const raw = request({ type: "object", properties: {
      plan: { type: "string", oneOf: [{ const: "basic", title: "Basic" }] },
      note: { type: "string", minLength: 2, maxLength: 4 },
    } });
    raw.params.mode = mode;
    const form = compileElicitation(raw, safeText);
    const [plan, note] = form.questions;
    expect(form.respond({ [form.actionId]: ["Allow once"], [plan.questionId]: ["1. Basic"] })?.content).toEqual({ plan: "basic" });
    expect(form.respond({ [form.actionId]: ["Allow once"], [note.questionId]: ["x"] })).toBeNull();
    expect(form.respond({ [form.actionId]: ["toString"] })).toBeNull();
    expect(form.respond({ [form.actionId]: ["Allow once"], unknown: ["x"] })).toBeNull();
  });
  it.each(["http://example.com", "https://localhost", "https://127.0.0.1", "https://user:pass@example.com", "https://[::1]"])("rejects unsafe navigation %s", (url) => {
    const raw = request(null);
    Object.assign(raw.params, { mode: "url", url, elicitationId: "auth-1" });
    expect(() => compileElicitation(raw, safeText)).toThrow();
  });
  it.each([
    { type: "object", properties: { nested: { type: "object", properties: {} } } },
    { type: "object", properties: {}, required: ["missing"] },
    { type: "object", properties: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i), { type: "string" }])) },
    { type: "object", properties: { value: { type: "array" } } },
    { type: "object", properties: { value: { type: "number", enum: ["one"] } } },
    { type: "object", properties: { value: { type: "boolean", minimum: 1 } } },
    { type: "object", properties: { value: { type: "string", items: { enum: ["one"] } } } },
    { type: "object", properties: { value: { type: "string", minLength: 401 } }, required: ["value"] },
    { type: "object", properties: { value: { type: "string", maxLength: 0 } }, required: ["value"] },
    { type: "object", properties: { value: { type: "string", minLength: 4, maxLength: 3 } } },
    { type: "object", properties: { value: { type: "array", items: { enum: ["a", "b", "c", "d", "e"] }, minItems: 5 } }, required: ["value"] },
    { type: "object", properties: { value: { type: "array", items: { enum: ["a"] }, maxItems: 0 } }, required: ["value"] },
    { type: "object", properties: { value: { type: "array", items: { enum: ["a"] }, minItems: 2 } } },
    { type: "object", properties: { value: { type: "integer", minimum: 1.1, maximum: 1.9 } } },
  ])("fails unsupported schemas closed", (schema) => {
    expect(() => compileElicitation(request(schema), safeText)).toThrow();
  });
  it("validates number syntax, integer precision, required fields and date formats", () => {
    const form = compileElicitation(request({ type: "object", properties: { n: { type: "integer" }, date: { type: "string", format: "date" } }, required: ["n"] }), safeText);
    const [number, date] = form.questions;
    expect(form.respond({ [form.actionId]: ["Allow once"] })).toBeNull();
    for (const invalid of ["1.5", "Infinity", "1e400", "9007199254740992", "0x10"]) {
      expect(form.respond({ [form.actionId]: ["Allow once"], [number.questionId]: [invalid] })).toBeNull();
    }
    expect(form.respond({ [form.actionId]: ["Allow once"], [number.questionId]: ["1"], [date.questionId]: ["not-a-date"] })).toBeNull();
    expect(form.respond({ [form.actionId]: ["Allow once"], [number.questionId]: ["1"], [date.questionId]: ["2026-09-07"] })?.content).toEqual({ n: 1, date: "2026-09-07" });
  });
  it("exposes a safe URL for explicit user navigation, never automatic navigation", () => {
    const raw = request(null);
    Object.assign(raw.params, { mode: "url", url: "https://connect.example.com/authorize", elicitationId: "auth-1" });
    const form = compileElicitation(raw, safeText);
    expect(form.connectorUrl).toBe("https://connect.example.com/authorize");
    expect(form.respond({ [form.actionId]: ["Allow once"] })).toEqual({ action: "accept", content: null, _meta: null });
    Object.assign(raw.params, { url: "javascript:alert(1)" });
    expect(() => compileElicitation(raw, safeText)).toThrow();
  });
  it("validates typed form answers and allows cancellation without filling required fields", () => {
    const form = compileElicitation(request({ type: "object", properties: {
      count: { type: "integer", minimum: 1, maximum: 5 },
      enabled: { type: "boolean" },
      tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1 },
    }, required: ["count", "enabled", "tags"] }), safeText);
    const [count, enabled, tags] = form.questions;
    const answers = { [form.actionId]: ["Allow once"], [count.questionId]: ["3"], [enabled.questionId]: ["True"], [tags.questionId]: ["1. a", "2. b"] };
    expect(form.respond(answers)).toEqual({ action: "accept", content: { count: 3, enabled: true, tags: ["a", "b"] }, _meta: null });
    expect(form.respond({ ...answers, [count.questionId]: ["99"] })).toBeNull();
    expect(form.respond({ [form.actionId]: ["Cancel"] })?.action).toBe("cancel");
  });
  it("requires explicit consent and returns the native response without a session grant", () => {
    const form = compileElicitation(request(null), safeText);
    expect(form.questions).toHaveLength(1);
    expect(form.respond({})).toBeNull();
    expect(form.respond({ [form.actionId]: ["Allow once"] })).toEqual({ action: "accept", content: {}, _meta: null });
    expect(form.respond({ [form.actionId]: ["Decline"] })).toEqual({ action: "decline", content: null, _meta: null });
    expect(form.respond({ [form.actionId]: ["Cancel"] })).toEqual({ action: "cancel", content: null, _meta: null });
  });
});
