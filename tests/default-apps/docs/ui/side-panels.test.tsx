// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocx } from "../../../../home/apps/_shared/office-engine/index";
import type { DocsPanelProps } from "../../../../home/apps/docs/src/ui/panel-types";
import { SidePanels, createPanelLoader } from "../../../../home/apps/docs/src/ui/SidePanels";
import { DocumentSession } from "../../../../home/apps/docs/src/session/index";
import { createFakeFiles } from "../session/fakes";

afterEach(cleanup);

async function session(): Promise<DocumentSession> {
  const value = new DocumentSession({ files: createFakeFiles(), author: "Rae Okafor", autosave: false });
  await value.adopt(createDocx({ paragraphs: ["Hello"] }), { name: "Test", dirty: false });
  return value;
}

function baseProps(docs: DocumentSession): DocsPanelProps {
  return { session: docs, editor: null, pickDocument: async () => null, onClose: () => undefined };
}

describe("side panel loading", () => {
  it("shows a fallback when the module is absent", async () => {
    const Panel = createPanelLoader({}, "./agent/DocsAgentPanel.tsx", "DocsAgentPanel", "The assistant is not available.");
    render(<Panel {...baseProps(await session())} />);
    expect(screen.getByText("The assistant is not available.")).toBeTruthy();
  });

  it("renders the default or named export of a present module with the panel props", async () => {
    const docs = await session();
    function Named({ session: given }: DocsPanelProps) {
      return <p>named panel for {given.getState().name}</p>;
    }
    const Panel = createPanelLoader({ "./compare/ComparePanel.tsx": async () => ({ ComparePanel: Named }) }, "./compare/ComparePanel.tsx", "ComparePanel", "absent");
    render(
      <Suspense fallback={<p>loading</p>}>
        <Panel {...baseProps(docs)} />
      </Suspense>,
    );
    expect(await screen.findByText("named panel for Test")).toBeTruthy();
  });

  it("shows a fallback when the module fails to load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const Panel = createPanelLoader({ "./compare/ComparePanel.tsx": async () => Promise.reject(new Error("chunk failed")) }, "./compare/ComparePanel.tsx", "ComparePanel", "absent");
    render(
      <Suspense fallback={<p>loading</p>}>
        <Panel {...baseProps(await session())} />
      </Suspense>,
    );
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("<SidePanels>", () => {
  it("switches tabs, contains a panel that throws, and closes", async () => {
    const docs = await session();
    const onClose = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    function Broken(): React.ReactElement {
      throw new Error("panel bug");
    }
    function Harness() {
      const [active, setActive] = React.useState<"review" | "assistant" | "compare">("review");
      return (
        <SidePanels
          {...baseProps(docs)}
          onClose={onClose}
          review={null}
          readOnly={false}
          active={active}
          onChange={setActive}
          panels={{ review: () => <p>review content</p>, assistant: () => <p>assistant content</p>, compare: Broken }}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByText("review content")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));
    expect(screen.getByText("assistant content")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Compare/ }));
    await waitFor(() => expect(screen.getByText("This panel stopped working")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Review/ }));
    expect(screen.getByText("review content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close side panel" }));
    expect(onClose).toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });
});
