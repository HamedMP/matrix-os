export function chatInputPlaceholder({ transcribing, recording, connected, unavailable }: {
  transcribing: boolean; recording: boolean; connected: boolean; unavailable?: string;
}) {
  if (transcribing) return "Transcribing...";
  if (recording) return "Listening...";
  return connected ? "Ask anything..." : unavailable ?? "Connecting...";
}

export function canSendChatInput(input: { connected: boolean; sending: boolean; allowed: boolean; busy: boolean; references: number; text: string; attachments: number }) {
  return input.connected && !input.sending && input.allowed && (!input.busy || input.references > 0)
    && Boolean(input.text.trim() || input.references || input.attachments);
}
