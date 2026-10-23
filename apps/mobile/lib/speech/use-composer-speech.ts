import {
  PlatformSpeechRecorderError,
  usePlatformSpeechDraft,
  type PlatformSpeechDraftClient,
} from "@matrix-os/ui/speech";
import { useQueryClient } from "@tanstack/react-query";
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
} from "expo-audio";
import { getRandomValues } from "expo-crypto";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Linking, Platform } from "react-native";

import { tapHaptic } from "@/lib/haptics";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { mobileQueryKeys } from "@/lib/requests/query-keys";

import { createMicrophoneCaptureAdapter, type MicrophonePermission, type SpeechRecording } from "./capture";
import { createGatewaySpeechClient, SpeechRequestError } from "./client";
import { appendTranscript, type ComposerSpeech } from "./composer-speech";
import { SPEECH_SAMPLE_RATE, type PcmBuffer } from "./pcm-collector";

// Speech is switched on or off per computer, rarely, so one answer serves
// every chat for a while. Coming back to the app asks again when it was off.
const CAPABILITIES_STALE_MS = 5 * 60_000;

export interface UseComposerSpeechOptions {
  /** The draft the words go into. Another one drops dictation in progress. */
  draftKey: string;
  draft: string;
  onChangeDraft: (text: string) => void;
  /** False while the composer cannot be used; it then offers no dictation. */
  enabled?: boolean;
}

type BufferListener = (buffer: PcmBuffer) => void;
type StatusListener = (status: { isStreaming: boolean }) => void;

/**
 * Passes expo-audio's stream events to the one recording listening at the
 * time; a later listener replaces it, and a removed one hears nothing more.
 */
function createStreamRelay() {
  let buffer: BufferListener | null = null;
  let status: StatusListener | null = null;
  return {
    deliverBuffer: (data: PcmBuffer) => buffer?.(data),
    deliverStatus: (state: { isStreaming: boolean }) => status?.(state),
    onBuffer: (listener: BufferListener) => {
      buffer = listener;
      return { remove: () => { if (buffer === listener) buffer = null; } };
    },
    onStatus: (listener: StatusListener) => {
      status = listener;
      return { remove: () => { if (status === listener) status = null; } };
    },
  };
}

function speechRequestId(): string {
  const entropy = getRandomValues(new Uint8Array(12));
  return `sp_${Date.now()}_${Array.from(entropy, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function safeSpeechMessage(error: unknown): string | undefined {
  return error instanceof SpeechRequestError || error instanceof PlatformSpeechRecorderError
    ? error.safeMessage
    : undefined;
}

function openMicrophoneSettings(): void {
  Alert.alert(
    "Microphone access is off",
    "To dictate messages, allow Matrix OS to use the microphone in Settings.",
    [
      { text: "Not now", style: "cancel" },
      {
        text: "Open Settings",
        onPress: () => {
          void Linking.openSettings().catch((error: unknown) => {
            console.warn("[speech] settings could not be opened", error instanceof Error ? error.name : "UnknownError");
          });
        },
      },
    ],
  );
}

/** Asks for the microphone; once refused for good, offers the way to Settings instead. */
async function requestMicrophone(): Promise<MicrophonePermission> {
  const current = await getRecordingPermissionsAsync();
  if (current.granted) return current;
  if (!current.canAskAgain) {
    openMicrophoneSettings();
    return current;
  }
  return requestRecordingPermissionsAsync();
}

/**
 * iOS leaves the audio session set for recording after the microphone closes,
 * which would silence sound the app plays later; put back the system default.
 */
function releaseAudioSession(): void {
  if (Platform.OS !== "ios") return;
  void setAudioModeAsync({ playsInSilentMode: false, interruptionMode: "doNotMix", allowsRecording: false })
    .catch((error: unknown) => {
      console.warn("[speech] audio session could not be released", error instanceof Error ? error.name : "UnknownError");
    });
}

/**
 * Dictation for a composer: records the microphone, has the computer's
 * gateway transcribe it as the web app does, and adds the words to the draft
 * for the person to edit and send. Nothing is sent by itself.
 *
 * Resolves to undefined, and the composer shows no microphone, while the
 * computer has no speech or the composer cannot be used.
 */
export function useComposerSpeech({
  draftKey,
  draft,
  onChangeDraft,
  enabled = true,
}: UseComposerSpeechOptions): ComposerSpeech | undefined {
  const queryClient = useQueryClient();
  const { userId, computerKey, session } = useActiveGateway();
  const [attempt, setAttempt] = useState(0);

  // The stream's buffers and on/off state go to whichever recording listens now.
  const [relay] = useState(createStreamRelay);
  const { stream, isStreaming } = useAudioStream({
    sampleRate: SPEECH_SAMPLE_RATE,
    channels: 1,
    encoding: "int16",
    onBuffer: relay.deliverBuffer,
  });
  useEffect(() => {
    relay.deliverStatus({ isStreaming });
  }, [relay, isStreaming]);

  // Asks for the recording to end and be transcribed: the system took the
  // microphone, it is full, or the app left the screen.
  const [endRequests, setEndRequests] = useState(0);
  const requestEnd = useCallback(() => setEndRequests((current) => current + 1), []);

  const adapter = useMemo(() => createMicrophoneCaptureAdapter({
    stream: {
      start: () => stream.start(),
      stop: () => stream.stop(),
      onBuffer: relay.onBuffer,
      onStatus: relay.onStatus,
    },
    requestPermission: requestMicrophone,
    releaseAudioSession,
    onEnded: requestEnd,
  }), [stream, relay, requestEnd]);

  const capabilitiesKey = useMemo(() => mobileQueryKeys.speechCapabilities(userId, computerKey), [userId, computerKey]);
  const client = useMemo<PlatformSpeechDraftClient<SpeechRecording>>(() => {
    const gateway = createGatewaySpeechClient(session);
    return {
      ...gateway,
      capabilities: () => queryClient.fetchQuery({
        queryKey: capabilitiesKey,
        queryFn: ({ signal }) => gateway.capabilities(signal),
        staleTime: CAPABILITIES_STALE_MS,
        retry: false,
      }),
    };
  }, [queryClient, capabilitiesKey, session]);

  // The words arrive long after the render that asked for them, and go after
  // whatever the draft holds by then.
  const latest = useRef({ draft, onChangeDraft, phase: "loading" });
  useEffect(() => {
    latest.current.draft = draft;
    latest.current.onChangeDraft = onChangeDraft;
  });

  const speech = usePlatformSpeechDraft<SpeechRecording>({
    // A new account, computer, draft or attempt drops whatever is in progress.
    scopeKey: `${userId}:${computerKey}:${draftKey}:${enabled ? "on" : "off"}:${attempt}`,
    client,
    captureAdapter: adapter,
    requestIdFactory: speechRequestId,
    safeErrorMessage: safeSpeechMessage,
    onDraft: (text) => latest.current.onChangeDraft(appendTranscript(latest.current.draft, text)),
  });
  useEffect(() => {
    latest.current.phase = speech.phase;
  });

  const handledEnds = useRef(0);
  useEffect(() => {
    if (endRequests === handledEnds.current) return;
    handledEnds.current = endRequests;
    // Stopping keeps what was said; it does nothing once the recording is over.
    speech.stop();
  }, [endRequests, speech]);

  // Choosing another tab hides the screen without unmounting it. The
  // microphone does not keep listening there: the recording ends and what was
  // said goes into the draft, as when leaving the app.
  const focused = useIsFocused();
  const { phase, stop: stopRecording } = speech;
  useEffect(() => {
    if (!focused && phase === "recording") stopRecording();
  }, [focused, phase, stopRecording]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      // Leaving the app ends the recording; what was said is still transcribed.
      if (state === "background" && latest.current.phase === "recording") requestEnd();
      if (state === "active" && latest.current.phase === "unavailable") {
        void queryClient.invalidateQueries({ queryKey: capabilitiesKey }).then(() => setAttempt((current) => current + 1));
      }
    });
    return () => subscription.remove();
  }, [queryClient, capabilitiesKey, requestEnd]);

  if (!enabled || !speech.isSupported) return undefined;
  if (speech.phase === "loading" || speech.phase === "unavailable") return undefined;
  return {
    phase: speech.phase,
    elapsedMs: speech.elapsedMs,
    inputLevel: speech.inputLevel,
    inputLevelSequence: speech.inputLevelSequence,
    error: speech.error,
    start: () => {
      tapHaptic();
      void speech.start();
    },
    stop: () => {
      tapHaptic();
      speech.stop();
    },
    cancel: speech.cancel,
  };
}
