// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppFrame, BackToHome, DocumentTitleBar } from "../../../home/apps/_shared/office-ui";

afterEach(cleanup);

describe("BackToHome", () => {
  it("shows the app name with an accessible back label and fires onClick", () => {
    const onClick = vi.fn();
    render(<BackToHome label="Sheets" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Back to Sheets home" });
    expect(button.textContent).toContain("Sheets");
    expect(button.getAttribute("title")).toBe("Back to Sheets home");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("DocumentTitleBar", () => {
  it("composes back button, document name, save state and actions", () => {
    const onHome = vi.fn();
    render(
      <DocumentTitleBar appName="Docs" onHome={onHome} name="Quarterly report" saveState="saving" actions={<button type="button">Share</button>} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to Docs home" }));
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Quarterly report" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Saving…");
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull();
  });

  it("renames on Enter, trims, and ignores blank or unchanged names", () => {
    const onRename = vi.fn();
    render(<DocumentTitleBar appName="Docs" onHome={vi.fn()} name="Draft" onRename={onRename} saveState="saved" />);
    expect(screen.getByRole("status").textContent).toBe("Saved");
    fireEvent.click(screen.getByRole("button", { name: "Rename Draft" }));
    const input = screen.getByRole("textbox", { name: "Document name" }) as HTMLInputElement;
    expect(input.value).toBe("Draft");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "  Q3 plan  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("Q3 plan");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename Draft" }));

    fireEvent.click(screen.getByRole("button", { name: "Rename Draft" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("cancels rename on Escape", () => {
    const onRename = vi.fn();
    render(<DocumentTitleBar appName="Sheets" onHome={vi.fn()} name="Budget" onRename={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Budget" }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Other" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Budget" })).toBeTruthy();
  });

  it("replaces the default AppFrame title row when given as titleBar", () => {
    render(
      <AppFrame titleBar={<DocumentTitleBar appName="Docs" onHome={vi.fn()} name="Letter" />}>
        <p>Body</p>
      </AppFrame>,
    );
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Letter" })).toBeTruthy();
    expect(screen.getByRole("banner").contains(screen.getByRole("button", { name: "Back to Docs home" }))).toBe(true);
  });
});
