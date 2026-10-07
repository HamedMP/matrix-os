// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewTabContent } from "../../shell/src/components/preview-window/PreviewTab";
vi.mock("../../shell/src/hooks/usePreviewWindow", () => ({ usePreviewWindow: (selector: (state: unknown) => unknown) => selector({ markUnsaved: vi.fn(), markSaved: vi.fn(), setMode: vi.fn() }) }));
vi.mock("../../shell/src/components/preview-window/CodeEditor", () => ({ CodeEditor: ({ content }: { content: string }) => <textarea readOnly value={content} /> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows the bounded inert CSV summary while preserving the original editable source", async () => {
  const source = 'Name,Value\n"Alice, A",=1+2';
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => source }));
  render(<PreviewTabContent tab={{ id: "csv", name: "bank.csv", path: "imports/bank.csv", type: "text", mode: "source" }} />);
  expect((await screen.findByLabelText("Import preview")).textContent).toContain("Table preview · 1 row");
  expect(screen.getByLabelText("Import preview").textContent).toContain("Alice, A | =1+2");
  expect((await screen.findByRole("textbox") as HTMLTextAreaElement).value).toBe(source);
});
