// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { openDocx } from "../../../../home/apps/_shared/office-engine/index";
import { DEFAULT_AUTOSAVE_DELAY_MS } from "../../../../home/apps/docs/src/session/index";
import { docxFromParagraphs, findSurface, installBridge, placeCaretAtEnd, renderApp, typeInto } from "./harness";

afterEach(() => {
  cleanup();
  delete (window as { MatrixOS?: unknown }).MatrixOS;
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Docs saves before its window goes away", () => {
  for (const leave of ["blur", "pagehide"] as const) {
    it(`writes typed text at once on ${leave}, without waiting for the autosave pause`, async () => {
      const bridge = installBridge({ "Documents/Plan.docx": await docxFromParagraphs(["Hello"]) }, { pending: "Documents/Plan.docx" });
      renderApp();
      const surface = await findSurface();
      placeCaretAtEnd(surface);
      typeInto(surface, " world");
      await act(async () => {
        window.dispatchEvent(new Event(leave));
      });
      await settle();
      const saved = await openDocx(bridge.files.bytes("Documents/Plan.docx"));
      expect(saved.getPlainText({ view: "final" })).toContain("Hello world");
    });
  }

  it("autosaves after a short pause", () => {
    expect(DEFAULT_AUTOSAVE_DELAY_MS).toBeLessThanOrEqual(1000);
  });
});
