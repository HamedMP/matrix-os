import {
  BrowserSpeechClientError,
  createBrowserSpeechClient,
  createWebPcmSpeechCaptureAdapter,
  PlatformSpeechRecorderError,
  resolveSpeechWorkletUrl,
  ChatSpeechInputButton,
  ChatSpeechQuotaStatus,
  usePlatformSpeechDraft,
  type BrowserSpeechClient,
  type PlatformSpeechCaptureAdapter,
} from "@matrix-os/ui";
import { useEffect, useMemo } from "react";
import { useConnection } from "../../stores/connection";

function speechErrorMessage(error: unknown) {
  if (error instanceof BrowserSpeechClientError || error instanceof PlatformSpeechRecorderError) return error.safeMessage;
  return undefined;
}

export function DesktopSpeechInputControl({
  scopeKey,
  client,
  captureAdapter,
  onDraft,
  disabled,
  onActiveChange,
}: {
  scopeKey: string;
  client: BrowserSpeechClient;
  captureAdapter: PlatformSpeechCaptureAdapter;
  onDraft: (text: string) => void;
  disabled: boolean;
  onActiveChange?: (active: boolean) => void;
}) {
  const speech = usePlatformSpeechDraft({ scopeKey, client, captureAdapter, onDraft, safeErrorMessage: speechErrorMessage });
  const active = ["requesting_permission", "recording", "transcribing"].includes(speech.phase);
  useEffect(() => {
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [active, onActiveChange]);
  return <>
    <ChatSpeechQuotaStatus speech={speech} />
    <ChatSpeechInputButton speech={speech} disabled={disabled} />
  </>;
}

export function useConnectedDesktopSpeechInput(input: {
  scopeKey: string;
  onDraft: (text: string) => void;
} | undefined) {
  const connectionStatus = useConnection((state) => state.status);
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const userId = useConnection((state) => state.userId);
  const authGeneration = useConnection((state) => state.authGeneration);
  const available = Boolean(input && connectionStatus === "signed-in" && platformHost && userId);
  const client = useMemo(() => available && platformHost
    ? createBrowserSpeechClient({ baseUrl: platformHost, runtimeSlot })
    : null, [available, platformHost, runtimeSlot]);
  const captureAdapter = useMemo(() => createWebPcmSpeechCaptureAdapter({
    workletUrl: resolveSpeechWorkletUrl(),
  }), []);
  const speech = usePlatformSpeechDraft({
    scopeKey: JSON.stringify([input?.scopeKey, platformHost, userId, authGeneration, runtimeSlot]),
    client,
    captureAdapter,
    onDraft: text => input?.onDraft(text),
    safeErrorMessage: speechErrorMessage,
  });
  return client ? speech : undefined;
}
