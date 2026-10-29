import {
  BrowserSpeechClientError,
  createBrowserSpeechClient,
  createWebPcmSpeechCaptureAdapter,
  PlatformSpeechRecorderError,
  resolveSpeechWorkletUrl,
  ChatSpeechInputButton,
  usePlatformSpeechDraft,
  type BrowserSpeechClient,
  type PlatformSpeechCaptureAdapter,
} from "@matrix-os/ui";
import { useEffect, useMemo } from "react";
import { useConnection } from "../../stores/connection";

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
  const speech = usePlatformSpeechDraft({
    scopeKey,
    client,
    captureAdapter,
    onDraft,
    safeErrorMessage: (caught) => caught instanceof BrowserSpeechClientError
      ? caught.safeMessage
      : caught instanceof PlatformSpeechRecorderError ? caught.safeMessage : undefined,
  });
  const active = ["requesting_permission", "recording", "transcribing"].includes(speech.phase);
  useEffect(() => {
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [active, onActiveChange]);
  return <ChatSpeechInputButton speech={speech} disabled={disabled} />;
}

export function ConnectedDesktopSpeechInput({
  scopeKey,
  onDraft,
  disabled,
  onActiveChange,
}: {
  scopeKey: string;
  onDraft: (text: string) => void;
  disabled: boolean;
  onActiveChange?: (active: boolean) => void;
}) {
  const connectionStatus = useConnection((state) => state.status);
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const userId = useConnection((state) => state.userId);
  const authGeneration = useConnection((state) => state.authGeneration);
  const client = useMemo(() => connectionStatus === "signed-in" && platformHost
    ? createBrowserSpeechClient({ baseUrl: platformHost, runtimeSlot })
    : null, [connectionStatus, platformHost, runtimeSlot]);
  const captureAdapter = useMemo(() => createWebPcmSpeechCaptureAdapter({
    workletUrl: resolveSpeechWorkletUrl(),
  }), []);
  if (!client || !userId) return null;
  return (
    <DesktopSpeechInputControl
      scopeKey={`${userId}:${authGeneration}:${runtimeSlot}:${scopeKey}`}
      client={client}
      captureAdapter={captureAdapter}
      onDraft={onDraft}
      disabled={disabled}
      onActiveChange={onActiveChange}
    />
  );
}
