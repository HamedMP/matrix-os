// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { runAssistantEdit } from "../../../../home/apps/docs/src/agent/index";
import { DocsAgentPanel } from "../../../../home/apps/docs/src/ui/agent/DocsAgentPanel";
import { contractSession } from "./helpers";

afterEach(() => {
  cleanup();
  delete (window as { MatrixOS?: unknown }).MatrixOS;
});

const denied = async () => ({ error: "App AI access denied" }) as unknown as { text: string };

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Docs assistant without AI access", () => {
  it("reports a refused reply as unavailable, not as an answer it could not check", async () => {
    const { session } = await contractSession();
    const result = await runAssistantEdit({ session, generate: denied }, { instruction: "Make the payment term 45 days" });
    expect(result).toMatchObject({ status: "failed", reason: "unavailable" });
  });

  it("does not offer the assistant when the host says AI is not allowed, and says how to allow it", async () => {
    const { session } = await contractSession();
    (window as { MatrixOS?: unknown }).MatrixOS = { ai: { generate: denied }, capabilities: async () => ({ version: 1, integrations: true, ai: false }) };
    render(<DocsAgentPanel session={session} editor={null} />);
    await flush();
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textbox.disabled).toBe(true);
    expect(document.body.textContent).toContain("AI access is not turned on for Docs");
    expect(document.body.textContent).toContain("app-ai.json");
  });

  it("offers the assistant when the host allows AI", async () => {
    const { session } = await contractSession();
    (window as { MatrixOS?: unknown }).MatrixOS = { ai: { generate: denied }, capabilities: async () => ({ version: 1, integrations: true, ai: true }) };
    render(<DocsAgentPanel session={session} editor={null} />);
    await flush();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
  });
});
