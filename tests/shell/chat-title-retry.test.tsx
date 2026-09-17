// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTitleEditor as WebEditor } from "../../shell/src/components/chat/ChatTitleRename";
import { ChatTitleEditor as ElectronEditor } from "../../desktop/src/renderer/src/features/chat/ChatTitleEditor";

afterEach(cleanup);
for (const surface of ["Web", "Electron"] as const) {
  describe(`${surface} title draft`, () => {
    it("retains the draft and permits retry after a failed request", () => {
      const commit = vi.fn();
      const cancel = vi.fn();
      const editor = (pending: boolean) => surface === "Web"
        ? <WebEditor title="Original" pending={pending} onCommit={commit} onCancel={cancel} />
        : <ElectronEditor title="Original" disabled={pending} onCommit={commit} onCancel={cancel} />;
      const view = render(editor(false));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "My draft" } });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      view.rerender(editor(true));
      view.rerender(editor(false));
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("My draft");
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(commit).toHaveBeenCalledTimes(2);
      expect(cancel).not.toHaveBeenCalled();
    });
  });
}
