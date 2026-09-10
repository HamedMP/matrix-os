// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSpeechClient,
  PlatformSpeechCapture,
  PlatformSpeechCaptureAdapter,
} from "@matrix-os/ui";
import { BrowserSpeechClientError } from "@matrix-os/ui";
import { DesktopSpeechInputControl } from "../../desktop/src/renderer/src/features/chat/DesktopSpeechInputControl";

const capabilities = {
  contractVersion: 1 as const,
  fileTranscription: {
    status: "ready" as const,
    dictation: {
      enabled: true as const,
      maxBytes: 10 * 1024 * 1024,
      maxDurationMs: 120_000,
      maxTranscriptChars: 32_000,
      supportedMediaTypes: ["audio/wav" as const],
      languageHints: false,
    },
    ownerAudio: { enabled: false as const },
  },
};

function client(): BrowserSpeechClient {
  return {
    capabilities: vi.fn(async () => capabilities),
    transcribe: vi.fn(async ({ requestId }) => ({
      contractVersion: 1,
      requestId,
      status: "succeeded",
      outcome: "transcript",
      text: "spoken draft",
      audioDurationMs: 1_000,
    })),
    cancel: vi.fn(async (requestId) => ({
      contractVersion: 1,
      requestId,
      executionState: "cancelled",
      cancellationRequested: true,
      executionStarted: false,
    })),
  };
}

describe("Electron shared Chat speech input", () => {
  afterEach(cleanup);

  it("records once and inserts an editable draft without submitting", async () => {
    const speechClient = client();
    const capture: PlatformSpeechCapture = {
      stop: vi.fn(async () => new Blob([new Uint8Array(44)], { type: "audio/wav" })),
      cancel: vi.fn(async () => undefined),
    };
    const captureAdapter: PlatformSpeechCaptureAdapter = {
      isSupported: () => true,
      start: vi.fn(async () => capture),
    };
    const onDraft = vi.fn();
    render(<DesktopSpeechInputControl
      scopeKey="account-a:primary:chat-a"
      client={speechClient}
      captureAdapter={captureAdapter}
      onDraft={onDraft}
      disabled={false}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop recording" }));

    await waitFor(() => expect(onDraft).toHaveBeenCalledWith("spoken draft"));
    expect(speechClient.transcribe).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Start voice input" })).toBeTruthy();
  });

  it("cancels delayed permission and cleans up a late capture", async () => {
    const permission = Promise.withResolvers<PlatformSpeechCapture>();
    const capture: PlatformSpeechCapture = {
      stop: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    const captureAdapter: PlatformSpeechCaptureAdapter = {
      isSupported: () => true,
      start: vi.fn(() => permission.promise),
    };
    render(<DesktopSpeechInputControl
      scopeKey="account-a:primary:chat-a"
      client={client()}
      captureAdapter={captureAdapter}
      onDraft={vi.fn()}
      disabled={false}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel microphone request" }));
    permission.resolve(capture);

    await waitFor(() => expect(capture.cancel).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Start voice input" })).toBeTruthy();
  });

  it("shows only a safe failure and permits a clean repeated attempt", async () => {
    const speechClient = client();
    vi.mocked(speechClient.transcribe)
      .mockRejectedValueOnce(new BrowserSpeechClientError("transcription_failed", "Transcription failed"));
    const captureAdapter: PlatformSpeechCaptureAdapter = {
      isSupported: () => true,
      start: vi.fn(async () => ({
        stop: vi.fn(async () => new Blob([new Uint8Array(44)], { type: "audio/wav" })),
        cancel: vi.fn(async () => undefined),
      })),
    };
    const onDraft = vi.fn();
    render(<DesktopSpeechInputControl
      scopeKey="account-a:primary:chat-a"
      client={speechClient}
      captureAdapter={captureAdapter}
      onDraft={onDraft}
      disabled={false}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop recording" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Transcription failed");

    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop recording" }));
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith("spoken draft"));
    expect(captureAdapter.start).toHaveBeenCalledTimes(2);
    expect(speechClient.transcribe).toHaveBeenCalledTimes(2);
  });
});
