import { describe, it, expect } from "vitest";
import { PromptContentSchema } from "../../packages/gateway/src/prompt-validation.js";

describe("prompt-validation", () => {
  it("accepts normal text prompts", () => {
    expect(PromptContentSchema.safeParse("fix the login bug").success).toBe(true);
  });

  it("accepts multi-line prompts with newlines", () => {
    expect(PromptContentSchema.safeParse("fix this:\n- bug A\n- bug B").success).toBe(true);
  });

  it("accepts prompts with tabs", () => {
    expect(PromptContentSchema.safeParse("indent\twith\ttabs").success).toBe(true);
  });

  it("accepts prompts with carriage returns", () => {
    expect(PromptContentSchema.safeParse("line1\r\nline2").success).toBe(true);
  });

  it("rejects prompts containing null bytes", () => {
    expect(PromptContentSchema.safeParse("hello\x00world").success).toBe(false);
  });

  it("rejects prompts containing BEL and other control chars", () => {
    expect(PromptContentSchema.safeParse("hello\x07world").success).toBe(false);
    expect(PromptContentSchema.safeParse("hello\x01world").success).toBe(false);
    expect(PromptContentSchema.safeParse("hello\x7Fworld").success).toBe(false);
  });

  it("accepts empty string", () => {
    expect(PromptContentSchema.safeParse("").success).toBe(true);
  });

  it("rejects prompts exceeding max length", () => {
    expect(PromptContentSchema.safeParse("a".repeat(100_001)).success).toBe(false);
  });

  it("accepts prompts at max length", () => {
    expect(PromptContentSchema.safeParse("a".repeat(100_000)).success).toBe(true);
  });
});
