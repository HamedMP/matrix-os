// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import React, { StrictMode, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createDocx } from "../../../../home/apps/_shared/office-engine/index";
import { DocumentEditor, useEditorSnapshot, useSessionState } from "../../../../home/apps/docs/src/editor/index";
import type { DocumentEditorController, EditorSelection, ViewMode } from "../../../../home/apps/docs/src/editor/index";
import { DocumentSession } from "../../../../home/apps/docs/src/session/index";
import { createFakeFiles } from "../session/fakes";
import { OWNER, at, bodyParagraphs } from "./helpers";

afterEach(cleanup);

async function sessionWith(paragraphs: string[]): Promise<DocumentSession> {
  const session = new DocumentSession({ files: createFakeFiles(), author: OWNER, autosave: false });
  await session.adopt(createDocx({ paragraphs }), { name: "Test", dirty: false });
  return session;
}

function typeInto(surface: HTMLElement, text: string): void {
  for (const character of text) {
    surface.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: character, bubbles: true, cancelable: true }));
  }
}

describe("<DocumentEditor>", () => {
  it("renders the session's document and hands out the controller", async () => {
    const session = await sessionWith(["Hello world", "Second"]);
    let controller: DocumentEditorController | null = null;
    let mountedAtRef = false;
    const firstId = bodyParagraphs(session.requireDocument())[0]!.id;
    const ready: DocumentEditorController[] = [];
    render(
      <DocumentEditor
        session={session}
        ariaLabel="Plan"
        className="pane"
        ref={(value) => {
          controller = value;
          if (value !== null) mountedAtRef = value.getBlockElement(firstId) !== null;
        }}
        onReady={(value) => ready.push(value)}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Plan" });
    expect(surface.getAttribute("contenteditable")).toBe("true");
    expect(surface.textContent).toBe("Hello worldSecond");
    expect(surface.closest(".doc-editor-host")?.classList.contains("pane")).toBe(true);
    expect(controller).not.toBeNull();
    expect(ready).toEqual([controller]);
    // The controller was already showing the document when the ref received it.
    expect(mountedAtRef).toBe(true);

    const id = bodyParagraphs(session.requireDocument())[0]!.id;
    act(() => {
      controller!.setSelection(at(id, 5));
      typeInto(surface, "!");
    });
    expect(session.requireDocument().getPlainText()).toBe("Hello! world\nSecond\n");
    expect(surface.textContent).toBe("Hello! worldSecond");
  });

  it("survives StrictMode's double mount and cleans up when unmounted", async () => {
    const session = await sessionWith(["Hello"]);
    const view = render(
      <StrictMode>
        <DocumentEditor session={session} />
      </StrictMode>,
    );
    expect(view.container.querySelectorAll(".doc-page")).toHaveLength(1);
    const surface = screen.getByRole("textbox", { name: "Document" });
    const id = bodyParagraphs(session.requireDocument())[0]!.id;
    act(() => {
      session.apply([{ type: "insertText", at: at(id, 5), text: " there" }]);
    });
    expect(surface.textContent).toBe("Hello there");
    view.unmount();
    // After unmount the session keeps working and nothing renders any more.
    session.apply([{ type: "insertText", at: at(id, 0), text: "x" }]);
    expect(surface.textContent).toBe("Hello there");
    expect(document.querySelector(".doc-page")).toBeNull();
  });

  it("follows the viewMode and readOnly props and reports selection changes", async () => {
    const session = await sessionWith(["Hello brave world"]);
    const id = bodyParagraphs(session.requireDocument())[0]!.id;
    session.apply([{ type: "deleteRange", range: { start: at(id, 6), end: at(id, 12) } }], { track: true, author: "Sam Lindqvist" });
    const selections: Array<EditorSelection | null> = [];
    let controller: DocumentEditorController | null = null;
    const ui = (viewMode: ViewMode, readOnly: boolean) => (
      <DocumentEditor
        session={session}
        viewMode={viewMode}
        readOnly={readOnly}
        ref={(value) => {
          controller = value;
        }}
        onSelectionChange={(selection) => selections.push(selection)}
      />
    );
    const view = render(ui("markup", false));
    const surface = screen.getByRole("textbox");
    expect(surface.textContent).toBe("Hello brave world");
    view.rerender(ui("final", false));
    expect(surface.textContent).toBe("Hello world");
    expect(controller!.getViewMode()).toBe("final");
    view.rerender(ui("final", true));
    expect(surface.getAttribute("contenteditable")).toBe("false");
    act(() => {
      controller!.setSelection(at(id, 2));
    });
    expect(selections.at(-1)).toMatchObject({ focus: at(id, 2) });
  });

  it("feeds toolbar state through the hooks", async () => {
    const session = await sessionWith(["Hello world"]);
    const id = bodyParagraphs(session.requireDocument())[0]!.id;
    function Shell() {
      const [editor, setEditor] = useState<DocumentEditorController | null>(null);
      const snapshot = useEditorSnapshot(editor);
      const state = useSessionState(session);
      return (
        <div>
          <output data-testid="status">{`${snapshot.viewMode}|${snapshot.activeFormat?.bold ?? "none"}|${state.dirty}|${state.tracking}|${state.canUndo}`}</output>
          <button type="button" onClick={() => editor?.format("bold")}>
            Bold
          </button>
          <DocumentEditor session={session} ref={setEditor} />
        </div>
      );
    }
    render(<Shell />);
    const status = screen.getByTestId("status");
    expect(status.textContent).toBe("markup|none|false|false|false");
    const surface = screen.getByRole("textbox");
    const leaf = surface.querySelector("[data-s]")!.firstChild!;
    act(() => {
      document.getSelection()!.setBaseAndExtent(leaf, 0, leaf, 5);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(status.textContent).toBe("markup|false|false|false|false");
    act(() => {
      screen.getByRole("button", { name: "Bold" }).click();
    });
    expect(status.textContent).toBe("markup|true|true|false|true");
    expect(session.requireDocument().getBlock(id)).toMatchObject({ runs: [{ text: "Hello", bold: true }, { text: " world" }] });
    act(() => {
      session.setTracking(true);
    });
    expect(status.textContent).toBe("markup|true|true|true|true");
  });

  it("builds a new editor when it is given another session", async () => {
    const first = await sessionWith(["First document"]);
    const second = await sessionWith(["Second document"]);
    const view = render(<DocumentEditor session={first} />);
    expect(screen.getByRole("textbox").textContent).toBe("First document");
    view.rerender(<DocumentEditor session={second} />);
    expect(view.container.querySelectorAll(".doc-page")).toHaveLength(1);
    expect(screen.getByRole("textbox").textContent).toBe("Second document");
  });
});
