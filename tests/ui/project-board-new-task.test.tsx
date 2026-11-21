// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NewTaskDialog } from "../../packages/ui/src/project-board/BoardDialogs";

beforeAll(() => {
  // jsdom has no modal dialog support.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.open = false; };
});
afterEach(cleanup);

describe("NewTaskDialog", () => {
  it("keeps the fields read-only while the task is being created, so nothing typed after Create is lost", async () => {
    let finish: (created: boolean) => void = () => {};
    const onCreate = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<NewTaskDialog open onClose={vi.fn()} members={[]} labels={[]} onCreate={onCreate} />);
    const title = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    const description = screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "Ship it" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create task" })); });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(title.readOnly).toBe(true);
    expect(description.readOnly).toBe(true);
    await act(async () => { finish(false); });
    expect(title.readOnly).toBe(false);
  });
});
