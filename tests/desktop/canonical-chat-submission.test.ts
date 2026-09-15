import { canonicalChatTitle } from "@desktop/renderer/src/features/chat/canonical-chat-submission";
import { describe, expect, it } from "vitest";

describe("canonical Chat submission", () => {
  it("creates a concise title instead of copying the first prompt verbatim", () => {
    const prompt = "Please inspect this computer without modifying files. Use Bash exactly three times and include a table.";

    expect(canonicalChatTitle({
      text: prompt,
      agentPrompt: prompt,
      invocations: [],
      resources: [],
    })).toBe("Inspect this computer without modifying files");
  });

  it("turns structured instruction prompts into topic-style titles", () => {
    const prompt = "write exactly twelve numbered short lines, each starting mat480_stream_, and use the bash tool once to run printf mat480_tool_ok before the final answer.";

    expect(canonicalChatTitle({
      text: prompt,
      agentPrompt: prompt,
      invocations: [],
      resources: [],
    })).toBe("Mat480 stream lines");
  });

  it("uses visible resource labels and omits leading slash commands from titles", () => {
    expect(canonicalChatTitle({
      text: "/matrix-app-builder inspect [CLAUDE.md](CLAUDE.md) and explain the app architecture in detail",
      agentPrompt: "",
      invocations: [{ kind: "skill", descriptorId: "matrix-app-builder", invocation: "/matrix-app-builder" }],
      resources: [{ kind: "file", id: "CLAUDE.md", label: "CLAUDE.md" }],
    })).toBe("Inspect CLAUDE.md and explain the app architecture in…");
  });

  it("keeps multilingual titles concise without losing their meaning", () => {
    const title = canonicalChatTitle({
      text: "请帮我检查 project chat 的 provider 同步问题，然后修复 navigation 和 streaming",
      agentPrompt: "",
      invocations: [],
      resources: [],
    });

    expect(title).toBe("检查 project chat 的 provider 同步问题，然后修复 navigation 和…");
    expect(title.length).toBeLessThanOrEqual(56);
  });
});

describe("generated title boundaries", () => {
  it("uses the first Chinese sentence from the reported prompt", () => {
    expect(canonicalChatTitle({ text: "我想设计一个个人主页。请先用 request_user_input 工具询问我喜欢的视觉风格，提供三个选项和简短说明。", agentPrompt: "", resources: [], invocations: [] })).toBe("我想设计一个个人主页");
  });

  it("bounds resource-only fallback titles", () => {
    const title = canonicalChatTitle({ text: "", agentPrompt: "", invocations: [], resources: [{ kind: "file", id: "f", label: "长".repeat(200) }] });
    expect(title).toBe("长".repeat(55) + "…");
  });

  it("bounds invocation-only fallback titles", () => {
    const title = canonicalChatTitle({ text: "", agentPrompt: "", resources: [], invocations: [{ kind: "skill", descriptorId: "s", invocation: "/" + "x".repeat(200) }] });
    expect(title.length).toBeLessThanOrEqual(56);
  });

  it("never splits emoji graphemes when truncating", () => {
    const emoji = "👩🏽‍💻";
    const title = canonicalChatTitle({ text: emoji.repeat(80), agentPrompt: "", resources: [], invocations: [] });
    expect(title.endsWith("…")).toBe(true);
    expect(title.slice(0, -1).split(emoji).join("")).toBe("");
    expect(title.length).toBeLessThanOrEqual(56);
  });
});
