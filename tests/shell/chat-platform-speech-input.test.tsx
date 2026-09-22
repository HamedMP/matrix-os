// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "../../shell/src/components/chat/ChatInput.js";
import { useChatComposerDraft } from "../../shell/src/components/chat/useChatComposerDraft.js";
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

function TestComposer({
  connected = true,
  onSubmit,
  client = speechClient(),
  adapter = captureAdapter,
  unavailablePlaceholder,
}: {
  connected?: boolean;
  onSubmit: ReturnType<typeof vi.fn>;
  client?: BrowserSpeechClient;
  adapter?: PlatformSpeechCaptureAdapter;
  unavailablePlaceholder?: string;
}) {
  const composer = useChatComposerDraft("chat-1", "owner-1");
  return <ChatInput
    composer={composer}
    scope="chat-1"
    permissionMode="supervised"
    connected={connected}
    busy={false}
    onSubmit={onSubmit}
    attachmentsEnabled={false}
    unavailablePlaceholder={unavailablePlaceholder}
    speechClient={client}
    speechCaptureAdapter={adapter}
  />;
}

describe("shared chat platform speech input", () => {
  beforeEach(() => {
    stopCapture.mockClear();
  });

  it("appends transcription to the current editable draft and requires manual Send", async () => {
    const onSubmit = vi.fn();
    render(<TestComposer onSubmit={onSubmit} />);
    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.change(textarea, { target: { value: "Typed first" } });
    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    await screen.findByRole("button", { name: "Stop recording" });
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe("Typed first spoken addition"));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(textarea, { target: { value: "Typed first spoken addition, edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledWith(
      "Typed first spoken addition, edited",
      undefined,
      expect.objectContaining({ permissionMode: "supervised", resources: [] }),
    );
  });

  it("keeps local stop available after connectivity drops and does not submit with Enter while recording", async () => {
    const onSubmit = vi.fn();
    const client = speechClient();
    const view = render(<TestComposer onSubmit={onSubmit} client={client} />);
    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.change(textarea, { target: { value: "Keep this draft" } });
    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    const stop = await screen.findByRole("button", { name: "Stop recording" });

    view.rerender(<TestComposer connected={false} onSubmit={onSubmit} client={client} />);

    expect(stop.hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(stop);
      await Promise.resolve();
    });
    expect(stopCapture).toHaveBeenCalledTimes(1);
  });

  it("shows an input-reactive recording waveform and removes it after Stop", async () => {
    let emitLevel: ((level: number) => void) | undefined;
    const meteredCapture: PlatformSpeechCaptureAdapter = {
      isSupported: () => true,
      start: vi.fn(async (input) => {
        emitLevel = input.onLevel;
        return { stop: stopCapture, cancel: vi.fn(async () => undefined) };
      }),
    };
    render(<TestComposer onSubmit={vi.fn()} adapter={meteredCapture} />);

    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    const waveform = await screen.findByTestId("speech-input-waveform");
    expect(waveform.getAttribute("data-level")).toBe("0");
    act(() => emitLevel?.(0.8));
    await waitFor(() => expect(waveform.getAttribute("data-level")).toBe("0.8"));
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await waitFor(() => expect(screen.queryByTestId("speech-input-waveform")).toBeNull());
  });

  it("allows ready dictation to create a draft before an AI harness is connected", async () => {
    const onSubmit = vi.fn();
    render(<TestComposer
      connected={false}
      onSubmit={onSubmit}
      unavailablePlaceholder="Write or dictate a draft — connect a harness to send"
    />);

    expect(screen.getByPlaceholderText("Write or dictate a draft — connect a harness to send").hasAttribute("disabled")).toBe(false);
    const microphone = await screen.findByRole("button", { name: "Start voice input" });
    await waitFor(() => expect(microphone.hasAttribute("disabled")).toBe(false));
    fireEvent.click(microphone);
    const stop = await screen.findByRole("button", { name: "Stop recording" });
    await act(async () => {
      fireEvent.click(stop);
      await Promise.resolve();
    });

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("spoken addition"));
    expect(textarea.hasAttribute("disabled")).toBe(false);
    fireEvent.change(textarea, { target: { value: "spoken addition, edited" } });
    expect(textarea.value).toBe("spoken addition, edited");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("allows a pending microphone permission request to be cancelled and fences a late stream", async () => {
    let resolveCapture!: (capture: Awaited<ReturnType<PlatformSpeechCaptureAdapter["start"]>>) => void;
    const lateCancel = vi.fn(async () => undefined);
    const pendingCapture: PlatformSpeechCaptureAdapter = {
      isSupported: () => true,
      start: vi.fn(() => new Promise((resolve) => { resolveCapture = resolve; })),
    };
    const onSubmit = vi.fn();
    render(<TestComposer onSubmit={onSubmit} adapter={pendingCapture} />);

    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.change(textarea, { target: { value: "Keep the pending draft" } });
    fireEvent.click(await screen.findByRole("button", { name: "Start voice input" }));
    const cancel = await screen.findByRole("button", { name: "Cancel microphone request" });
    expect(cancel.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
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
