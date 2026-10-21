import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { Alert, AppState, Linking, Platform, type AppStateStatus } from "react-native";

import { disposeTestQueryClient } from "./query-test-cleanup";

// Screen suites get a composer without dictation; this suite tests the real hook.
jest.unmock("@/lib/speech/use-composer-speech");

const READY = {
  contractVersion: 1,
  fileTranscription: {
    status: "ready",
    dictation: {
      enabled: true,
      maxBytes: 10 * 1024 * 1024,
      maxDurationMs: 120_000,
      maxTranscriptChars: 32_000,
      supportedMediaTypes: ["audio/wav"],
      languageHints: false,
    },
    ownerAudio: { enabled: false },
  },
} as const;
const DISABLED = {
  contractVersion: 1,
  fileTranscription: {
    status: "unavailable",
    reason: "disabled",
    dictation: { ...READY.fileTranscription.dictation, enabled: false },
    ownerAudio: { enabled: false },
  },
} as const;

const mockClient = {
  capabilities: jest.fn(),
  transcribe: jest.fn(),
  cancel: jest.fn(async () => undefined),
};
const mockGateway = { userId: "user_1", computerKey: "alice:primary" };
const mockFocus = { current: true };
const mockStream = {
  onBuffer: null as ((buffer: unknown) => void) | null,
  setStreaming: null as ((isStreaming: boolean) => void) | null,
  start: jest.fn(async () => undefined),
  stop: jest.fn(),
};
const mockPermissions = {
  current: { granted: true, canAskAgain: true, status: "granted" },
  requested: { granted: true, canAskAgain: true, status: "granted" },
};

jest.mock("@/lib/queries/use-active-gateway", () => ({
  useActiveGateway: () => ({
    userId: mockGateway.userId,
    computerKey: mockGateway.computerKey,
    session: async () => ({ token: "clerk-token", gatewayUrl: "https://app.matrix-os.com/vm/alice" }),
  }),
}));
jest.mock("expo-router", () => ({ useIsFocused: () => mockFocus.current }));
jest.mock("@/lib/speech/client", () => ({
  ...jest.requireActual("@/lib/speech/client"),
  createGatewaySpeechClient: () => mockClient,
}));
jest.mock("expo-audio", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useState } = require("react") as typeof import("react");
  return {
    // Like expo-audio's hook: buffers go to the latest onBuffer, the on/off state is React state.
    useAudioStream: (options: { onBuffer?: (buffer: unknown) => void }) => {
      const [isStreaming, setStreaming] = useState(false);
      mockStream.onBuffer = options.onBuffer ?? null;
      mockStream.setStreaming = setStreaming;
      return { stream: mockStream, isStreaming };
    },
    getRecordingPermissionsAsync: jest.fn(async () => mockPermissions.current),
    requestRecordingPermissionsAsync: jest.fn(async () => mockPermissions.requested),
    setAudioModeAsync: jest.fn(async () => undefined),
  };
});

// eslint-disable-next-line import/first
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
// eslint-disable-next-line import/first
import { useComposerSpeech } from "@/lib/speech/use-composer-speech";

let queryClient: QueryClient;
let appStateListener: ((state: AppStateStatus) => void) | null = null;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderSpeech(initial: { draftKey?: string; draft?: string; enabled?: boolean } = {}) {
  const onChangeDraft = jest.fn();
  const props = { draftKey: "chat-1", draft: "", enabled: true, ...initial, onChangeDraft };
  const view = renderHook((current: typeof props) => useComposerSpeech(current), { wrapper, initialProps: props });
  return { ...view, onChangeDraft, props };
}

function speak(samples: readonly number[] = [4_000, -4_000, 8_000]) {
  act(() => mockStream.onBuffer?.({ data: new Int16Array(samples).buffer, sampleRate: 16_000, channels: 1, timestamp: 0 }));
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockClient.capabilities.mockReset().mockResolvedValue(READY);
  mockClient.transcribe.mockReset().mockResolvedValue({ outcome: "transcript", text: "hello there" });
  mockClient.cancel.mockClear();
  mockStream.start.mockClear();
  mockStream.stop.mockClear();
  mockGateway.computerKey = "alice:primary";
  mockFocus.current = true;
  mockPermissions.current = { granted: true, canAskAgain: true, status: "granted" };
  mockPermissions.requested = { granted: true, canAskAgain: true, status: "granted" };
  jest.mocked(requestRecordingPermissionsAsync).mockClear();
  jest.mocked(getRecordingPermissionsAsync).mockClear();
  jest.mocked(setAudioModeAsync).mockClear();
  appStateListener = null;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    appStateListener = listener as (state: AppStateStatus) => void;
    return { remove: () => { appStateListener = null; } } as ReturnType<typeof AppState.addEventListener>;
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await disposeTestQueryClient(queryClient);
});

describe("useComposerSpeech", () => {
  it("offers dictation once the computer says it has speech", async () => {
    const { result } = renderSpeech();

    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current?.phase).toBe("idle"));
  });

  it("offers nothing when the computer has no speech", async () => {
    mockClient.capabilities.mockResolvedValue(DISABLED);
    const { result } = renderSpeech();

    await waitFor(() => expect(mockClient.capabilities).toHaveBeenCalled());
    await act(async () => undefined);
    expect(result.current).toBeUndefined();
  });

  it("offers nothing while the composer cannot be used", async () => {
    const { result } = renderSpeech({ enabled: false });

    await act(async () => undefined);
    expect(result.current).toBeUndefined();
  });

  it("asks once per computer, not once per chat", async () => {
    const { result, rerender, props } = renderSpeech();
    await waitFor(() => expect(result.current?.phase).toBe("idle"));

    rerender({ ...props, draftKey: "chat-2" });
    await waitFor(() => expect(result.current?.phase).toBe("idle"));

    expect(mockClient.capabilities).toHaveBeenCalledTimes(1);
  });

  it("records, transcribes, and puts the words after what is typed", async () => {
    const { result, onChangeDraft } = renderSpeech({ draft: "Please" });
    await waitFor(() => expect(result.current?.phase).toBe("idle"));

    act(() => result.current?.start());
    await waitFor(() => expect(result.current?.phase).toBe("recording"));
    speak();
    await waitFor(() => expect(result.current?.inputLevel).toBeGreaterThan(0));
    act(() => result.current?.stop());

    await waitFor(() => expect(onChangeDraft).toHaveBeenCalledWith("Please hello there"));
    expect(result.current?.phase).toBe("idle");
    const sent = mockClient.transcribe.mock.calls[0]![0];
    expect(sent.recording).toMatchObject({ type: "audio/wav", size: 44 + 6 });
    expect(sent.requestId).toMatch(/^sp_[0-9]{13}_[0-9a-f]{24}$/);
    expect(mockStream.stop).toHaveBeenCalled();
  });

  it("keeps what was typed while the words were on their way", async () => {
    let answer!: (value: { outcome: "transcript"; text: string }) => void;
    mockClient.transcribe.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const { result, rerender, props, onChangeDraft } = renderSpeech({ draft: "One" });
    await waitFor(() => expect(result.current?.phase).toBe("idle"));
    act(() => result.current?.start());
    await waitFor(() => expect(result.current?.phase).toBe("recording"));
    speak();
    act(() => result.current?.stop());
    await waitFor(() => expect(result.current?.phase).toBe("transcribing"));

    rerender({ ...props, draft: "One two" });
    await act(async () => answer({ outcome: "transcript", text: "three" }));

    expect(onChangeDraft).toHaveBeenLastCalledWith("One two three");
  });

  it("drops the recording and its words when the chat changes", async () => {
    let answer!: (value: { outcome: "transcript"; text: string }) => void;
    mockClient.transcribe.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const { result, rerender, props, onChangeDraft } = renderSpeech();
    await waitFor(() => expect(result.current?.phase).toBe("idle"));
    act(() => result.current?.start());
    await waitFor(() => expect(result.current?.phase).toBe("recording"));
    speak();
    act(() => result.current?.stop());
    await waitFor(() => expect(result.current?.phase).toBe("transcribing"));

    rerender({ ...props, draftKey: "chat-2" });
    await act(async () => answer({ outcome: "transcript", text: "for the old chat" }));

    expect(onChangeDraft).not.toHaveBeenCalled();
    expect(mockClient.cancel).toHaveBeenCalled();
  });

  it("closes the microphone when the chat changes mid-recording", async () => {
    const { result, rerender, props } = renderSpeech();
    await waitFor(() => expect(result.current?.phase).toBe("idle"));
    act(() => result.current?.start());
    await waitFor(() => expect(result.current?.phase).toBe("recording"));

    rerender({ ...props, draftKey: "chat-2" });

    await waitFor(() => expect(mockStream.stop).toHaveBeenCalled());
    expect(mockClient.transcribe).not.toHaveBeenCalled();
  });

  it("transcribes what was said when the app leaves the screen mid-recording", async () => {
    const { result, onChangeDraft } = renderSpeech();
    await waitFor(() => expect(result.current?.phase).toBe("idle"));
    act(() => result.current?.start());
    await waitFor(() => expect(result.current?.phase).toBe("recording"));
    speak();

    act(() => appStateListener?.("background"));

    await waitFor(() => expect(onChangeDraft).toHaveBeenCalledWith("hello there"));
    expect(mockStream.stop).toHaveBeenCalled();
  });

  it("transcribes what was said, and lets go of the microphone, when another tab hides the screen", async () => {
    const { result, rerender, props, onChangeDraft } = renderSpeech();
    await waitFor(() => expect(result.current?.phase).toBe("idle"));
    act(() => result.current?.start());
    await waitFor(() => expect(result.current?.phase).toBe("recording"));
    speak();

    // Tab screens stay mounted when another tab is chosen; only their focus changes.
    mockFocus.current = false;
    rerender({ ...props });

    await waitFor(() => expect(onChangeDraft).toHaveBeenCalledWith("hello there"));
    expect(mockStream.stop).toHaveBeenCalled();
  });

  it("keeps recording while the screen stays in view", async () => {
    const { result, rerender, props } = renderSpeech();
    await waitFor(() => expect(result.current?.phase).toBe("idle"));
    act(() => result.current?.start());
    await waitFor(() => expect(result.current?.phase).toBe("recording"));

    rerender({ ...props, draft: "typing alongside" });
    await act(async () => undefined);

    expect(result.current?.phase).toBe("recording");
    expect(mockStream.stop).not.toHaveBeenCalled();
  });

  it("transcribes what was said when the system takes the microphone", async () => {
    const { result, onChangeDraft } = renderSpeech();
    await waitFor(() => expect(result.current?.phase).toBe("idle"));
    act(() => result.current?.start());
    await waitFor(() => expect(result.current?.phase).toBe("recording"));
    speak();

    act(() => mockStream.setStreaming?.(true));
    act(() => mockStream.setStreaming?.(false));

    await waitFor(() => expect(onChangeDraft).toHaveBeenCalledWith("hello there"));
  });

  it("asks the computer again when the app comes back after speech was unavailable", async () => {
    mockClient.capabilities.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(READY);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { result } = renderSpeech();
    await waitFor(() => expect(mockClient.capabilities).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(result.current).toBeUndefined();

    act(() => appStateListener?.("active"));

    await waitFor(() => expect(result.current?.phase).toBe("idle"));
    warn.mockRestore();
  });

  it("says so when the microphone is refused at the prompt", async () => {
    mockPermissions.current = { granted: false, canAskAgain: true, status: "undetermined" };
    mockPermissions.requested = { granted: false, canAskAgain: false, status: "denied" };
    const alert = jest.spyOn(Alert, "alert");
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { result } = renderSpeech();
    await waitFor(() => expect(result.current?.phase).toBe("idle"));

    act(() => result.current?.start());

    await waitFor(() => expect(result.current?.phase).toBe("error"));
    expect(result.current?.error).toBe("Microphone access is off");
    expect(mockStream.start).not.toHaveBeenCalled();
    // The person has just answered the system's own prompt.
    expect(alert).not.toHaveBeenCalled();
  });

  it("points to Settings when the microphone was refused before", async () => {
    mockPermissions.current = { granted: false, canAskAgain: false, status: "denied" };
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { result } = renderSpeech();
    await waitFor(() => expect(result.current?.phase).toBe("idle"));

    act(() => result.current?.start());

    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    expect(requestRecordingPermissionsAsync).not.toHaveBeenCalled();
    const [title, , buttons] = alert.mock.calls[0]!;
    expect(title).toBe("Microphone access is off");
    const settings = buttons?.find((button) => button.text === "Open Settings");
    act(() => settings?.onPress?.());
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("gives the phone's audio back on iOS once the recording ends", async () => {
    const os = Platform.OS;
    Platform.OS = "ios";
    try {
      const { result } = renderSpeech();
      await waitFor(() => expect(result.current?.phase).toBe("idle"));
      act(() => result.current?.start());
      await waitFor(() => expect(result.current?.phase).toBe("recording"));
      act(() => result.current?.cancel());

      await waitFor(() => expect(setAudioModeAsync).toHaveBeenCalledWith({
        playsInSilentMode: false,
        interruptionMode: "doNotMix",
        allowsRecording: false,
      }));
    } finally {
      Platform.OS = os;
    }
  });
});
