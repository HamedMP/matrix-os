"use client";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { ChatNoticeCard, canonicalChatFailurePresentation, canonicalChatRunHarnessLabel, type CanonicalChatFailureActionKind } from "@matrix-os/ui";
import type { CanonicalFailureNoticeInput } from "@/lib/canonical-chat-terminal-notices";

export type CanonicalChatFailureHandlers = Partial<Record<CanonicalChatFailureActionKind, (turnId: string) => Promise<void> | void>>;

/** Web Desktop and Web Canvas render of a failed Run, matching Electron Desktop's notice. */
export function CanonicalChatFailureMessage({ failure, catalog, handlers }: {
  failure: CanonicalFailureNoticeInput;
  catalog?: CanonicalProviderCatalog | null;
  handlers: CanonicalChatFailureHandlers;
}) {
  const presentation = canonicalChatFailurePresentation(failure.error, {
    harnessLabel: canonicalChatRunHarnessLabel(failure, catalog),
    allowRetry: failure.allowRetry,
  });
  // A surface that cannot open a target omits the button rather than disabling it.
  const actions = presentation.actions.filter((action) => handlers[action.kind]);
  return (
    <ChatNoticeCard label={presentation.title} failed actions={actions.map((action) => ({ key: action.kind, label: action.label }))}
      onAction={(key) => handlers[key as CanonicalChatFailureActionKind]?.(failure.turnId)}>
      {presentation.message}
    </ChatNoticeCard>
  );
}
