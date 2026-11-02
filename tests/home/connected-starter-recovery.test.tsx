// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppErrorRecovery } from "../../home/app-templates/connected-starter/src/AppErrorRecovery";
import { Editor } from "../../home/app-templates/connected-starter/src/Dialogs";
import { readDefinition } from "../../home/app-templates/connected-starter/src/definition";

afterEach(() => { cleanup(); delete (window as Window & { MatrixOS?: unknown }).MatrixOS; });

describe("connected starter persistence recovery", () => {
  it("offers repair at a failed save and retries the same unsaved fields", async () => {
    const repair = vi.fn().mockResolvedValue({ chatId: "chat_repair" });
    Object.assign(window, { MatrixOS: { repair } });
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({});
    const close = vi.fn();
    render(<Editor app={readDefinition()} onSave={save} onArchive={vi.fn()} onClose={close} />);
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Draft expense" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Currency/ }), { target: { value: "USD" } });
    fireEvent.click(screen.getByRole("button", { name: "Save record" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fix with Matrix" })).toBeTruthy());
    expect((screen.getByRole("textbox", { name: /Title/ }) as HTMLInputElement).value).toBe("Draft expense");
    fireEvent.click(screen.getByRole("button", { name: "Fix with Matrix" }));
    await waitFor(() => expect(repair).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0].fields.title).toBe("Draft expense");
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("confirms a repair turn and lets the owner retry without losing an unsaved draft", async () => {
    let confirm!: (value: { chatId: string }) => void;
    const repair = vi.fn(() => new Promise<{ chatId: string }>(resolve => { confirm = resolve; }));
    Object.assign(window, { MatrixOS: { repair } });
    const retry = vi.fn();
    render(<><input aria-label="Unsaved draft" defaultValue="Keep this note" />
      <AppErrorRecovery message="The note could not be saved" retry={retry} /></>);
    fireEvent.click(screen.getByRole("button", { name: "Fix with Matrix" }));
    expect(repair).toHaveBeenCalledWith({ operation: "persistence", message: "The note could not be saved" });
    expect(screen.queryByText(/Matrix received/)).toBeNull();
    confirm({ chatId: "chat_repair" });
    await waitFor(() => expect(screen.getByText(/Matrix received/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect((screen.getByRole("textbox", { name: "Unsaved draft" }) as HTMLInputElement).value).toBe("Keep this note");
  });

  it("keeps recovery available when chat admission fails", async () => {
    Object.assign(window, { MatrixOS: { repair: vi.fn().mockRejectedValue(new Error("offline")) } });
    render(<AppErrorRecovery message="Save failed" retry={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fix with Matrix" }));
    await waitFor(() => expect(screen.getByText(/Could not open a repair chat/)).toBeTruthy());
    expect(screen.queryByText(/Matrix received/)).toBeNull();
    expect(screen.getByRole("button", { name: "Fix with Matrix" })).toBeTruthy();
  });
});
