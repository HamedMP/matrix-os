// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
