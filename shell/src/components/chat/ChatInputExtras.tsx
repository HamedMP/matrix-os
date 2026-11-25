import {chatResourceKey} from "@matrix-os/ui";
import { Button } from "@/components/ui/button";
import { MicIcon, MicOffIcon, Loader2Icon } from "@/lib/hugeicons";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";

export function ChatVoiceButton({ connected, recording, transcribing, onClick }: {
  connected: boolean; recording: boolean; transcribing: boolean; onClick(): void;
}) {
  return <Button type="button" aria-label={recording ? "Stop recording" : "Record voice message"} size="icon" variant="ghost"
    className={`size-8 rounded-full ${recording ? "text-red-500 animate-pulse" : "text-muted-foreground hover:text-foreground"}`}
    disabled={!connected || transcribing} onClick={onClick}>
    {transcribing ? <Loader2Icon className="size-4 animate-spin" /> : recording ? <MicOffIcon className="size-4" /> : <MicIcon className="size-4" />}
  </Button>;
}
export function ChatMentionTokens({ resources, onRemove }: {
  resources: CanonicalChatResourceReference[]; onRemove(resource: CanonicalChatResourceReference): void;
}) {
  if (!resources.length) return null;
  return <div className="flex min-w-0 max-w-full flex-wrap gap-2">{resources.map((resource) => <span key={chatResourceKey(resource)} className="flex min-w-0 max-w-full items-center gap-1 rounded-md border px-2 py-1 text-xs">
    <span className="min-w-0 truncate" title={resource.label}>@{resource.label}</span><button type="button" aria-label={`Remove ${resource.label}`} className="shrink-0 rounded px-1 focus-visible:ring-2" onClick={() => onRemove(resource)}>×</button>
  </span>)}</div>;
}

export function FailedChatMessage({ text, canRetry, sending, onRetry, onDiscard }: {
  text: string;
  canRetry: boolean;
  sending: boolean;
  onRetry(): void;
  onDiscard(): void;
}) {
  return <div className="flex items-center gap-2 rounded-lg border px-2 py-1">
    <p role="status" className="min-w-0 flex-1 truncate text-xs">Message failed{text ? `: ${text}` : ""}</p>
    <Button type="button" size="sm" variant="outline" disabled={!canRetry} onClick={onRetry}>Retry message</Button>
    <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={onDiscard}>Discard failed message</Button>
  </div>;
}
