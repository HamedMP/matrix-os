import type { KernelConversationContextProjection } from "@matrix-os/contracts";
import ConversationContextPicker from "./ConversationContextPicker";

interface ConversationContextComposerProps {
  context: KernelConversationContextProjection | null;
  disabled: boolean;
  error: string | null;
  onUpdate: (projectId: string | null) => void;
}

export function ConversationContextControls({
  context,
  disabled,
  onUpdate,
}: Omit<ConversationContextComposerProps, "error">) {
  return (
    <>
      <ConversationContextPicker
        context={context}
        disabled={disabled}
        onSelect={onUpdate}
        onRemove={() => onUpdate(null)}
      />
      {context?.repositoryLabel ? (
        <ConversationContextPicker
          context={context}
          disabled={disabled}
          triggerLabel={`Repository ${context.repositoryLabel}`}
          triggerText={context.repositoryLabel}
          onSelect={onUpdate}
          onRemove={() => onUpdate(null)}
        />
      ) : null}
    </>
  );
}

export function ConversationContextFeedback({
  context,
  disabled,
  error,
  onUpdate,
}: ConversationContextComposerProps) {
  if (context?.status !== "unavailable") {
    return error ? <div role="alert" className="min-w-0 flex-1">{error}</div> : null;
  }

  return (
    <div role="alert" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <span className="min-w-48 flex-1">
        This chat&apos;s project is unavailable. Choose another project or remove project context.
        {error ? ` ${error}` : ""}
      </span>
      <ConversationContextPicker
        context={context}
        disabled={disabled}
        triggerLabel="Choose another project"
        triggerText="Choose another project"
        onSelect={onUpdate}
        onRemove={() => onUpdate(null)}
      />
      <button
        type="button"
        aria-label="Remove project context"
        disabled={disabled}
        className="rounded-md px-2 py-1 text-xs font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
        onClick={() => onUpdate(null)}
      >
        Remove project context
      </button>
    </div>
  );
}
