// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "../../shell/src/components/ChatApp.js";
import type { BrowserSpeechClient } from "../../shell/src/lib/platform-speech-client.js";
import type { PlatformSpeechCaptureAdapter } from "../../packages/ui/src/index.js";

const requestId = "sp_1788998400000_abcdefghijklmnop";

const stopCapture = vi.fn(async () => new Blob([new Uint8Array(44)], { type: "audio/wav" }));
const captureAdapter: PlatformSpeechCaptureAdapter = {
  isSupported: () => true,
  start: vi.fn(async () => ({ stop: stopCapture, cancel: vi.fn(async () => undefined) })),
};

function speechClient(): BrowserSpeechClient {
  return {
    capabilities: vi.fn(async () => ({
      contractVersion: 1,
      fileTranscription: {
        status: "ready",
        dictation: {
          enabled: true,
          maxBytes: 1_024,
          maxDurationMs: 120_000,
          maxTranscriptChars: 32_000,
          supportedMediaTypes: ["audio/wav"],
          languageHints: false,
        },
        ownerAudio: { enabled: false },
      },
    })),
    transcribe: vi.fn(async ({ requestId: operationId }) => ({
      contractVersion: 1,
      requestId: operationId,
      status: "succeeded",
      outcome: "transcript",
      text: "spoken addition",
      audioDurationMs: 1_000,
    })),
    cancel: vi.fn(async () => ({
      contractVersion: 1,
      requestId,
      executionState: "cancelled",
      cancellationRequested: true,
      executionStarted: true,
    })),
  };
}

describe("shared chat platform speech input", () => {
  beforeEach(() => {
    stopCapture.mockClear();
  });

  it("appends transcription to the current editable draft and requires manual Send", async () => {
    const onSubmit = vi.fn();
    render(<ChatInput
      speechScopeKey="chat-1"
      connected
      busy={false}
      onSubmit={onSubmit}
      attachmentsEnabled={false}
      speechClient={speechClient()}
      speechCaptureAdapter={captureAdapter}
    />);
    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.change(textarea, { target: { value: "Typed first" } });
    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    await screen.findByRole("button", { name: "Stop recording" });
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe("Typed first spoken addition"));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(textarea, { target: { value: "Typed first spoken addition, edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledWith("Typed first spoken addition, edited");
  });

  it("keeps local stop available after connectivity drops and does not submit with Enter while recording", async () => {
    const onSubmit = vi.fn();
    const view = render(<ChatInput
      speechScopeKey="chat-1"
      connected
      busy={false}
      onSubmit={onSubmit}
      attachmentsEnabled={false}
      speechClient={speechClient()}
      speechCaptureAdapter={captureAdapter}
    />);
    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.change(textarea, { target: { value: "Keep this draft" } });
    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    const stop = await screen.findByRole("button", { name: "Stop recording" });

    view.rerender(<ChatInput
      speechScopeKey="chat-1"
      connected={false}
      busy={false}
      onSubmit={onSubmit}
      attachmentsEnabled={false}
      speechClient={speechClient()}
      speechCaptureAdapter={captureAdapter}
    />);

    expect(stop.hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(stop);
      await Promise.resolve();
    });
    expect(stopCapture).toHaveBeenCalledTimes(1);
  });

  it("allows a pending microphone permission request to be cancelled and fences a late stream", async () => {
    let resolveCapture!: (capture: Awaited<ReturnType<PlatformSpeechCaptureAdapter["start"]>>) => void;
    const lateCancel = vi.fn(async () => undefined);
    const pendingCapture: PlatformSpeechCaptureAdapter = {
      isSupported: () => true,
      start: vi.fn(() => new Promise((resolve) => { resolveCapture = resolve; })),
    };
    render(<ChatInput
      speechScopeKey="chat-1"
      connected
      busy={false}
      onSubmit={vi.fn()}
      attachmentsEnabled={false}
      speechClient={speechClient()}
      speechCaptureAdapter={pendingCapture}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    const cancel = await screen.findByRole("button", { name: "Cancel microphone request" });
    expect(cancel.hasAttribute("disabled")).toBe(false);
    fireEvent.click(cancel);
    await screen.findByRole("button", { name: "Start voice input" });

    await act(async () => {
      resolveCapture({
        stop: vi.fn(async () => new Blob([new Uint8Array(44)], { type: "audio/wav" })),
        cancel: lateCancel,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(lateCancel).toHaveBeenCalledTimes(1));
  });
});
