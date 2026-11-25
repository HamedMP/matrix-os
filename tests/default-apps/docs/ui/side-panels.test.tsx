// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocx } from "../../../../home/apps/_shared/office-engine/index";
import type { DocsPanelProps } from "../../../../home/apps/docs/src/ui/panel-types";
import { SidePanels } from "../../../../home/apps/docs/src/ui/SidePanels";
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

describe("side panel wiring", () => {
  it("loads the real Assistant and Compare panels and shows the Review tab", async () => {
    const docs = await session();
    function Harness() {
      const [active, setActive] = React.useState<"review" | "assistant" | "compare">("review");
      return <SidePanels {...baseProps(docs)} review={null} readOnly={false} active={active} onChange={setActive} />;
    }
    render(<Harness />);
    expect(screen.getByText("Loading review")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));
    expect(await screen.findByRole("group", { name: "Assistant mode" }, { timeout: 5000 })).toBeTruthy();
    // The side panel's own close button is the only one; the assistant adds no second close.
    expect(screen.queryByRole("button", { name: "Close Assistant" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Compare/ }));
    expect(await screen.findByRole("button", { name: "Choose from Files…" }, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("Not available")).toBeNull();
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
