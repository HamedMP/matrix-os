import {
  BrowserSpeechClientError,
  createBrowserSpeechClient,
  createWebPcmSpeechCaptureAdapter,
  PlatformSpeechRecorderError,
  resolveSpeechWorkletUrl,
  usePlatformSpeechDraft,
  type BrowserSpeechClient,
  type PlatformSpeechCaptureAdapter,
} from "@matrix-os/ui";
import { CircleStop, Loader2Icon, MicIcon, XCircleIcon } from "@renderer/lib/hugeicons";
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
  if (!speech.isSupported && !active && !speech.error) return null;
  const label = speech.phase === "requesting_permission"
    ? "Cancel microphone request"
    : speech.phase === "recording"
      ? "Stop recording"
      : speech.phase === "transcribing"
        ? "Cancel transcription"
        : "Start voice input";
  const activate = () => {
    if (speech.phase === "recording") speech.stop();
    else if (speech.phase === "requesting_permission" || speech.phase === "transcribing") speech.cancel();
    else void speech.start();
  };
  return (
    <div className="relative flex items-center gap-1">
      {speech.error ? (
        <span
          role="alert"
          className="absolute bottom-[calc(100%+0.5rem)] right-0 w-max max-w-64 rounded-lg border px-2.5 py-1.5 text-xs shadow-lg"
          style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)", color: "var(--danger)" }}
        >
          {speech.error}
        </span>
      ) : null}
      {speech.phase === "recording" ? (
        <span aria-live="polite" className="px-1 text-xs tabular-nums" style={{ color: "var(--text-tertiary)" }}>
          {Math.floor(speech.elapsedMs / 60_000)}:{String(Math.floor(speech.elapsedMs / 1_000) % 60).padStart(2, "0")}
        </span>
      ) : null}
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled && !active}
        onClick={activate}
        className="flex h-8 w-8 items-center justify-center rounded-full outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
        style={{ color: speech.phase === "recording" ? "var(--danger)" : "var(--text-secondary)" }}
      >
        {speech.phase === "requesting_permission" ? (
          <Loader2Icon size={16} aria-hidden className="animate-spin motion-reduce:animate-none" />
        ) : speech.phase === "transcribing" ? (
          <XCircleIcon size={16} aria-hidden />
        ) : speech.phase === "recording" ? (
          <CircleStop size={16} aria-hidden />
        ) : (
          <MicIcon size={16} aria-hidden />
        )}
      </button>
    </div>
  );
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
