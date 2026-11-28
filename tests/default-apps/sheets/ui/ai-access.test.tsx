// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { askModel, bridgeSheetsAi } from "../../../../home/apps/sheets/src/agent";
import { flush, renderApp, workbookBytes } from "./harness";

afterEach(cleanup);

const denied = async () => ({ error: "App AI access denied" }) as unknown as { text: string };

describe("Sheets assistant without AI access", () => {
  it("reads a refused reply as 'assistant unavailable', not as a bad answer", async () => {
    const ai = bridgeSheetsAi({ MatrixOS: { ai: { generate: denied } } });
    await expect(askModel(ai, "Add a total row")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not offer the assistant when the host says AI is not allowed, and says how to allow it", async () => {
    const bytes = await workbookBytes();
    await renderApp((bridge) => {
      bridge.fileStore.put("Budget.xlsx", bytes);
      bridge.pendingRequest = { path: "Budget.xlsx", requestedAt: new Date(0).toISOString(), nonce: "n1" };
      Object.assign(bridge, { ai: { generate: denied }, capabilities: async () => ({ version: 1, integrations: true, ai: false }) });
    });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
    await flush();
    const panel = screen.getByRole("complementary", { name: "Assistant" });
    expect(panel.textContent).toContain("AI access is not turned on for Sheets");
    expect(panel.textContent).toContain("app-ai.json");
    expect((within(panel).getByRole("button", { name: "Explain" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(panel).getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("offers the assistant when the host allows AI", async () => {
    const bytes = await workbookBytes();
    await renderApp((bridge) => {
      bridge.fileStore.put("Budget.xlsx", bytes);
      bridge.pendingRequest = { path: "Budget.xlsx", requestedAt: new Date(0).toISOString(), nonce: "n1" };
      Object.assign(bridge, { ai: { generate: async () => ({ text: "{}" }) }, capabilities: async () => ({ version: 1, integrations: true, ai: true }) });
    });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
    await flush();
    const panel = screen.getByRole("complementary", { name: "Assistant" });
    expect((within(panel).getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
  });
});
