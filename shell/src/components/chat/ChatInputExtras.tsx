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
  return <div className="flex flex-wrap gap-2">{resources.map((resource) => <span key={`${resource.kind}:${resource.id}`} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
    @{resource.label}<button type="button" aria-label={`Remove ${resource.label}`} className="rounded px-1 focus-visible:ring-2" onClick={() => onRemove(resource)}>×</button>
  </span>)}</div>;
}

