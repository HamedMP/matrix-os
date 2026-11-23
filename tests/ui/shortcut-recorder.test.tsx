// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SHORTCUT_OVERRIDES } from "@matrix-os/contracts/keyboard-shortcuts";
import { RECORDING_TIMEOUT_MS, ShortcutSettings } from "@matrix-os/ui/shortcuts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  const onChange = vi.fn(async () => true);
  const onRecordingChange = vi.fn();
  const utils = render(
    <ShortcutSettings
      platform="mac"
      overrides={EMPTY_SHORTCUT_OVERRIDES}
      onChange={onChange}
      onRecordingChange={onRecordingChange}
    />,
  );
  const showDesktop = () => screen.getByRole("group", { name: "Show desktop" });
  const startRecording = () => {
    fireEvent.click(within(showDesktop()).getByRole("button", { name: "Add shortcut" }));
  };
  const recordingChip = () => within(showDesktop()).queryByRole("status", { name: /Recording/ });
  return { ...utils, onChange, onRecordingChange, showDesktop, startRecording, recordingChip };
}

describe("shortcut recorder", () => {
  it("starts recording with a focused Press keys chip and reports it", () => {
    const { startRecording, recordingChip, onRecordingChange } = setup();
    startRecording();
    const chip = recordingChip();
    expect(chip).not.toBeNull();
    expect(chip).toHaveTextContent("Press keys…");
    expect(chip).toHaveFocus();
    expect(onRecordingChange).toHaveBeenCalledWith(true);
  });

  it("captures keydown before other listeners and prevents the default action", () => {
    const { startRecording, recordingChip } = setup();
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    startRecording();
    const notCancelled = fireEvent.keyDown(recordingChip()!, { key: "Shift", code: "ShiftLeft", shiftKey: true });
    expect(notCancelled).toBe(false);
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outside);
  });

  it("shows held modifiers live", () => {
    const { startRecording, recordingChip } = setup();
    startRecording();
    fireEvent.keyDown(recordingChip()!, { key: "Meta", code: "MetaLeft", metaKey: true });
    fireEvent.keyDown(recordingChip()!, { key: "Shift", code: "ShiftLeft", metaKey: true, shiftKey: true });
    expect(recordingChip()).toHaveTextContent("⌘⇧");
    fireEvent.keyUp(recordingChip()!, { key: "Shift", code: "ShiftLeft", metaKey: true });
    expect(recordingChip()).toHaveTextContent("⌘");
    expect(recordingChip()).not.toHaveTextContent("⇧");
  });

  it("records Tab instead of moving focus", async () => {
    const { startRecording, recordingChip, onChange, onRecordingChange } = setup();
    startRecording();
    const notCancelled = fireEvent.keyDown(recordingChip()!, { key: "Tab", code: "Tab", metaKey: true, altKey: true });
    expect(notCancelled).toBe(false);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ version: 1, overrides: { "app.show-desktop": ["Cmd+Alt+Tab"] } }),
    );
    expect(recordingChip()).toBeNull();
    expect(onRecordingChange).toHaveBeenLastCalledWith(false);
  });

  it("ignores key repeats", () => {
    const { startRecording, recordingChip, onChange } = setup();
    startRecording();
    fireEvent.keyDown(recordingChip()!, { key: "d", code: "KeyD", metaKey: true, shiftKey: true, repeat: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(recordingChip()).not.toBeNull();
  });

  it("cancels on Escape after a held modifier", () => {
    const { startRecording, recordingChip, onChange, onRecordingChange } = setup();
    startRecording();
    fireEvent.keyDown(recordingChip()!, { key: "Shift", code: "ShiftLeft", shiftKey: true });
    fireEvent.keyDown(recordingChip()!, { key: "Escape", code: "Escape", shiftKey: true });
    expect(recordingChip()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onRecordingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("cancels itself before main's 30 s guard re-enables shortcuts", () => {
    vi.useFakeTimers();
    const { startRecording, recordingChip, onChange, onRecordingChange } = setup();
    startRecording();
    expect(RECORDING_TIMEOUT_MS).toBe(25_000);
    act(() => { vi.advanceTimersByTime(RECORDING_TIMEOUT_MS - 1); });
    expect(recordingChip()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(recordingChip()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onRecordingChange.mock.calls).toEqual([[true], [false]]);
    act(() => { vi.advanceTimersByTime(RECORDING_TIMEOUT_MS); });
    expect(onRecordingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("cancels when focus leaves the row", () => {
    const { startRecording, recordingChip, onRecordingChange } = setup();
    startRecording();
    fireEvent.blur(recordingChip()!);
    expect(recordingChip()).toBeNull();
    expect(onRecordingChange).toHaveBeenLastCalledWith(false);
  });

  it("cancels when the window loses focus, so it stops together with the main-process guard", () => {
    const { startRecording, recordingChip, onRecordingChange } = setup();
    startRecording();
    fireEvent.blur(window);
    expect(recordingChip()).toBeNull();
    expect(onRecordingChange).toHaveBeenLastCalledWith(false);
  });

  it("toggles off when Add shortcut is pressed again", () => {
    const { startRecording, recordingChip, showDesktop, onRecordingChange } = setup();
    startRecording();
    fireEvent.click(within(showDesktop()).getByRole("button", { name: "Add shortcut" }));
    expect(recordingChip()).toBeNull();
    expect(onRecordingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("reports recording ended when unmounted mid-recording", () => {
    const { startRecording, unmount, onRecordingChange } = setup();
    startRecording();
    unmount();
    expect(onRecordingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("stops listening once recording ends", () => {
    const { startRecording, recordingChip, onChange } = setup();
    startRecording();
    fireEvent.keyDown(recordingChip()!, { key: "Escape", code: "Escape" });
    const notCancelled = fireEvent.keyDown(document.body, { key: "d", code: "KeyD", metaKey: true, shiftKey: true });
    expect(notCancelled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
