// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMPTY_SHORTCUT_OVERRIDES,
  resolveShortcuts,
  type ShortcutOverrides,
} from "@matrix-os/contracts/keyboard-shortcuts";
import {
  KeyChip,
  ShortcutSettings,
  rejectionMessage,
  type ShortcutSettingsProps,
} from "@matrix-os/ui/shortcuts";

// jsdom does not implement the modal <dialog> methods.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
});

function renderSettings(props: Partial<ShortcutSettingsProps> = {}) {
  const onChange = props.onChange ?? vi.fn(async () => true);
  const utils = render(
    <ShortcutSettings platform="mac" overrides={EMPTY_SHORTCUT_OVERRIDES} {...props} onChange={onChange} />,
  );
  return { ...utils, onChange };
}

function row(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

function chipLabels(rowName: string): string[] {
  return within(row(rowName))
    .queryAllByRole("button", { name: /^Remove / })
    .map((button) => button.getAttribute("aria-label")!.replace(/^Remove /, ""));
}

function record(rowName: string, init: Partial<KeyboardEventInit> & { key: string; code?: string }) {
  fireEvent.click(within(row(rowName)).getByRole("button", { name: "Add shortcut" }));
  const target = document.activeElement ?? document.body;
  fireEvent.keyDown(target, { code: "", ...init });
}

describe("ShortcutSettings layout", () => {
  it("renders the section description and groups in registry order", () => {
    renderSettings();
    expect(
      screen.getByText("Change how you control Matrix from the keyboard. Saved on this computer."),
    ).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(["Apps", "Navigation", "Tabs", "Chat", "Terminal"]);
  });

  it("shows the effective bindings for each row", () => {
    renderSettings();
    expect(chipLabels("Next app")).toEqual(["⌃⇥"]);
    expect(chipLabels("Open App Launcher")).toEqual(["⌥Space"]);
    expect(chipLabels("Show desktop")).toEqual([]);
  });

  it("uses words for modifiers outside macOS", () => {
    renderSettings({ platform: "other" });
    expect(chipLabels("Close app")).toEqual(["Ctrl+Q"]);
    expect(within(row("Close app")).getByText("Ctrl")).toBeInTheDocument();
  });

  it("collapses the nine switch actions into one disclosure", () => {
    renderSettings();
    const toggle = screen.getByRole("button", { name: /Switch to app 1–9/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Switch to app 3" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(chipLabels("Switch to app 3")).toEqual(["⌘3"]);
  });

  it("hides Reset (keeping its space) unless the row is overridden", () => {
    const overrides: ShortcutOverrides = { version: 1, overrides: { "app.close": ["Cmd+Q", "Cmd+Shift+Q"] } };
    renderSettings({ overrides });
    const closeReset = within(row("Close app")).getByRole("button", { name: "Reset" });
    expect(closeReset).toBeVisible();
    // A hidden element has no accessible name, so find it by its text.
    const nextReset = within(row("Next app")).getByText("Reset").closest("button")!;
    expect(nextReset).toHaveStyle({ visibility: "hidden" });
    expect(nextReset).not.toBeVisible();
  });
});

describe("ShortcutSettings editing", () => {
  it("adds a free, valid binding", async () => {
    const { onChange } = renderSettings();
    record("Show desktop", { key: "d", code: "KeyD", metaKey: true, shiftKey: true });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith({ version: 1, overrides: { "app.show-desktop": ["Cmd+Shift+D"] } });
  });

  it("shows a conflict and moves the binding on Replace", async () => {
    const { onChange } = renderSettings();
    record("Close app", { key: "Tab", code: "Tab", ctrlKey: true });
    expect(within(row("Close app")).getByText("⌃⇥ is used by Next app.")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(within(row("Close app")).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const next = (onChange as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ShortcutOverrides;
    expect(next.overrides["app.next"]).toEqual([]);
    expect(next.overrides["app.close"]).toEqual(["Cmd+Q", "Ctrl+Tab"]);
  });

  it("cancels a conflict without saving", () => {
    const { onChange } = renderSettings();
    record("Close app", { key: "Tab", code: "Tab", ctrlKey: true });
    fireEvent.click(within(row("Close app")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("⌃⇥ is used by Next app.")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("treats another action's untouched default as a conflict", () => {
    renderSettings();
    record("Show desktop", { key: "k", code: "KeyK", metaKey: true });
    expect(within(row("Show desktop")).getByText("⌘K is used by Command palette.")).toBeInTheDocument();
  });

  it("rejects reserved menu bindings without saving", () => {
    const { onChange } = renderSettings();
    record("Show desktop", { key: "c", code: "KeyC", metaKey: true });
    expect(within(row("Show desktop")).getByText("⌘C is reserved for Copy.")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects bindings without a modifier", () => {
    const { onChange } = renderSettings();
    record("Show desktop", { key: "a", code: "KeyA" });
    expect(within(row("Show desktop")).getByText("Add a modifier key such as ⌘ or ⌃.")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a binding the row already has", () => {
    const { onChange } = renderSettings();
    record("Close app", { key: "q", code: "KeyQ", metaKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(within(row("Close app")).queryByText(/is used by|reserved/)).toBeNull();
  });

  it("removes a binding from its chip", async () => {
    const { onChange } = renderSettings();
    fireEvent.click(within(row("Close app")).getByRole("button", { name: "Remove ⌘Q" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ version: 1, overrides: { "app.close": [] } }));
  });

  it("resets an overridden row", async () => {
    const overrides: ShortcutOverrides = { version: 1, overrides: { "app.close": [] } };
    const { onChange } = renderSettings({ overrides });
    fireEvent.click(within(row("Close app")).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ version: 1, overrides: {} }));
  });

  it("does not update optimistically and shows the error when the save fails", async () => {
    const onChange = vi.fn(async () => false);
    const { rerender } = renderSettings({ onChange });
    fireEvent.click(within(row("Close app")).getByRole("button", { name: "Remove ⌘Q" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(chipLabels("Close app")).toEqual(["⌘Q"]);
    rerender(
      <ShortcutSettings
        platform="mac"
        overrides={EMPTY_SHORTCUT_OVERRIDES}
        error="Could not save shortcut. Please try again."
        onChange={onChange}
      />,
    );
    expect(within(row("Close app")).getByText("Could not save shortcut. Please try again.")).toBeInTheDocument();
    expect(chipLabels("Close app")).toEqual(["⌘Q"]);
  });

  it("disables Add shortcut at four bindings and explains the limit", () => {
    const overrides: ShortcutOverrides = {
      version: 1,
      overrides: { "app.show-desktop": ["Cmd+Shift+1", "Cmd+Shift+2", "Cmd+Shift+3", "Cmd+Shift+4"] },
    };
    renderSettings({ overrides });
    expect(within(row("Show desktop")).getByRole("button", { name: "Add shortcut" })).toBeDisabled();
    expect(within(row("Show desktop")).getByText("An action can have up to 4 shortcuts.")).toBeInTheDocument();
  });

  it("restores all defaults after confirmation", async () => {
    const overrides: ShortcutOverrides = { version: 1, overrides: { "app.close": [] } };
    const { onChange } = renderSettings({ overrides });
    fireEvent.click(screen.getByRole("button", { name: "Restore all defaults" }));
    expect(screen.getByText("Restore all default shortcuts?")).toBeInTheDocument();
    expect(screen.getByText("Your custom shortcuts will be removed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(EMPTY_SHORTCUT_OVERRIDES));
  });
});

describe("ShortcutSettings save safety", () => {
  const SAVE_FAILED = "Could not save shortcut. Please try again.";

  function deferred() {
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("shows the save-failed message and logs when onChange rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("disk full");
    const onChange = vi.fn(async () => {
      throw failure;
    });
    renderSettings({ onChange });
    fireEvent.click(within(row("Close app")).getByRole("button", { name: "Remove ⌘Q" }));
    expect(await within(row("Close app")).findByText(SAVE_FAILED)).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), failure);
    consoleError.mockRestore();
  });

  it("shows the save-failed message when onChange resolves false without an error prop", async () => {
    renderSettings({ onChange: vi.fn(async () => false) });
    fireEvent.click(within(row("Close app")).getByRole("button", { name: "Remove ⌘Q" }));
    expect(await within(row("Close app")).findByText(SAVE_FAILED)).toBeInTheDocument();
  });

  it("shows the save-failed message at section level when Restore all fails", async () => {
    const overrides: ShortcutOverrides = { version: 1, overrides: { "app.close": [] } };
    renderSettings({ overrides, onChange: vi.fn(async () => false) });
    fireEvent.click(screen.getByRole("button", { name: "Restore all defaults" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
  });

  it("blocks overlapping saves until the pending save settles", async () => {
    const pending = deferred();
    const onChange = vi.fn(() => pending.promise);
    const overrides: ShortcutOverrides = { version: 1, overrides: { "app.show-desktop": ["Cmd+Shift+D"] } };
    renderSettings({ overrides, onChange });
    fireEvent.click(within(row("Close app")).getByRole("button", { name: "Remove ⌘Q" }));
    expect(onChange).toHaveBeenCalledTimes(1);

    fireEvent.click(within(row("Minimize app")).getByRole("button", { name: "Remove ⌘M" }));
    fireEvent.click(within(row("Show desktop")).getByRole("button", { name: "Reset" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(within(row("Minimize app")).getByRole("button", { name: "Remove ⌘M" })).toBeDisabled();
    expect(within(row("Minimize app")).getByRole("button", { name: "Add shortcut" })).toBeDisabled();
    expect(within(row("Show desktop")).getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore all defaults" })).toBeDisabled();

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(within(row("Minimize app")).getByRole("button", { name: "Add shortcut" })).toBeEnabled();
    expect(within(row("Minimize app")).getByRole("button", { name: "Remove ⌘M" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restore all defaults" })).toBeEnabled();
  });

  it("disables row controls and Restore all while the host is saving", () => {
    const overrides: ShortcutOverrides = { version: 1, overrides: { "app.show-desktop": ["Cmd+Shift+D"] } };
    renderSettings({ overrides, saving: true });
    expect(within(row("Show desktop")).getByRole("button", { name: "Remove ⌘⇧D" })).toBeDisabled();
    expect(within(row("Show desktop")).getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(within(row("Show desktop")).getByRole("button", { name: "Add shortcut" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore all defaults" })).toBeDisabled();
  });

  it("Reset takes the row's default bindings back from other actions", async () => {
    const overrides: ShortcutOverrides = { version: 1, overrides: { "app.next": [], "app.close": ["Cmd+Q", "Ctrl+Tab"] } };
    const { onChange } = renderSettings({ overrides });
    fireEvent.click(within(row("Next app")).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const next = (onChange as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ShortcutOverrides;
    const effective = resolveShortcuts(next, "mac");
    expect(effective["app.next"]).toEqual(["Ctrl+Tab"]);
    expect(effective["app.close"]).toEqual(["Cmd+Q"]);
  });
});

describe("ShortcutSettings search", () => {
  function search(value: string) {
    fireEvent.change(screen.getByRole("searchbox", { name: "Search shortcuts" }), { target: { value } });
  }

  it("filters rows by name", () => {
    renderSettings();
    search("launcher");
    // Every visible row has exactly one Add shortcut button.
    expect(screen.getAllByRole("button", { name: "Add shortcut" })).toHaveLength(1);
    expect(row("Open App Launcher")).toBeInTheDocument();
  });

  it("filters rows by binding text", () => {
    renderSettings();
    search("⌃⇥");
    expect(row("Next app")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Close app" })).toBeNull();
  });

  it("expands the switch disclosure when the search matches one", () => {
    renderSettings();
    search("app 4");
    expect(screen.getByRole("button", { name: /Switch to app 1–9/ })).toHaveAttribute("aria-expanded", "true");
    expect(row("Switch to app 4")).toBeInTheDocument();
  });

  it("clears a pending conflict when the search changes", () => {
    renderSettings();
    record("Close app", { key: "Tab", code: "Tab", ctrlKey: true });
    expect(screen.getByText("⌃⇥ is used by Next app.")).toBeInTheDocument();
    search("close");
    expect(screen.queryByText("⌃⇥ is used by Next app.")).toBeNull();
    search("");
    expect(screen.queryByText("⌃⇥ is used by Next app.")).toBeNull();
  });

  it("clears a pending rejection when overrides change from outside", () => {
    const { rerender, onChange } = renderSettings();
    record("Show desktop", { key: "c", code: "KeyC", metaKey: true });
    expect(screen.getByText("⌘C is reserved for Copy.")).toBeInTheDocument();
    rerender(
      <ShortcutSettings platform="mac" overrides={{ version: 1, overrides: { "app.close": [] } }} onChange={onChange} />,
    );
    expect(screen.queryByText("⌘C is reserved for Copy.")).toBeNull();
  });

  it("shows an empty state that clears the search", () => {
    renderSettings();
    search("zzz");
    expect(screen.getByText("No shortcuts match “zzz”.")).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    });
    expect(row("Next app")).toBeInTheDocument();
  });
});

describe("KeyChip and copy", () => {
  it("renders parts in one chip with a labelled remove control", () => {
    const onRemove = vi.fn();
    render(<KeyChip binding="Ctrl+Tab" platform="mac" label="Control Tab" onRemove={onRemove} />);
    expect(screen.getByRole("group", { name: "Control Tab" })).toHaveTextContent("⌃⇥");
    fireEvent.click(screen.getByRole("button", { name: "Remove ⌃⇥" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("words rejections per platform", () => {
    expect(rejectionMessage("Cmd+Space", { reason: "reserved-system" }, "mac")).toBe("⌘Space is reserved by macOS.");
    expect(rejectionMessage("Alt+F4", { reason: "reserved-system" }, "other")).toBe("Alt+F4 is reserved by the system.");
    expect(rejectionMessage("Ctrl+C", { reason: "reserved-menu", role: "Copy" }, "other")).toBe("Ctrl+C is reserved for Copy.");
    expect(rejectionMessage("A", { reason: "needs-modifier" }, "other")).toBe("Add a modifier key such as Ctrl or Alt.");
    expect(rejectionMessage("Cmd+Fn", { reason: "invalid" }, "mac")).toBe("That key can’t be used in a shortcut.");
  });
});
