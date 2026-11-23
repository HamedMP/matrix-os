/// <reference types="vite/client" />
/**
 * Mount points for modules built separately: the composer
 * (`ui/compose/Composer.tsx`) and the agent panel (`ui/agent/MailAgentPanel.tsx`).
 *
 * Each is loaded lazily through `import.meta.glob`, so a build without the
 * module still succeeds and shows a simple fallback. A module may export the
 * component as `default` or under its name (`Composer`, `MailAgentPanel`).
 * A render error inside a slot shows the fallback instead of taking the app down.
 */
import { Component, lazy, Suspense, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { Bot } from "lucide-react";
import { EmptyState, Spinner } from "../../../_shared/office-ui";
import type { DraftState, MailAccountEntry, MailState, MailStore } from "../model";
import { FallbackComposer } from "./FallbackComposer";

/** Props the workspace passes to `ui/compose/Composer`. */
export interface ComposerSlotProps {
  store: MailStore;
  state: MailState;
  /** The active, open draft. Its `localId` is what the store's draft actions take. */
  draft: DraftState;
  entries: readonly MailAccountEntry[];
  /** Closes the composer (the store keeps the draft). */
  onClose: () => void;
}

/** Props the workspace passes to `ui/agent/MailAgentPanel`. */
export interface MailAgentPanelSlotProps {
  store: MailStore;
  state: MailState;
  entries: readonly MailAccountEntry[];
  onClose: () => void;
}

type SlotModule = Record<string, unknown>;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A lazy component from the first matching module, or `fallback` when there is none. */
export function lazySlot<P extends object>(
  modules: Record<string, () => Promise<SlotModule>>,
  exportName: string,
  fallback: ComponentType<P>,
): ComponentType<P> {
  const loader = Object.values(modules)[0];
  if (!loader) return fallback;
  return lazy(async () => {
    try {
      const mod = await loader();
      const candidate = (mod.default ?? mod[exportName]) as ComponentType<P> | undefined;
      return { default: typeof candidate === "function" || typeof candidate === "object" ? candidate! : fallback };
    } catch (error: unknown) {
      console.warn(`[mail] slot.load.failed (${exportName}, ${errorName(error)})`);
      return { default: fallback };
    }
  });
}

class SlotBoundary extends Component<{ name: string; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    console.warn(`[mail] slot.render.failed (${this.props.name}, ${errorName(error)})`);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function FallbackAgentPanel({ onClose }: MailAgentPanelSlotProps) {
  return (
    <div className="mail-agent-fallback">
      <EmptyState
        icon={<Bot />}
        headline="The mail agent is not available"
        description="This build of Mail does not include the agent panel."
        action={{ label: "Close", onClick: onClose }}
      />
    </div>
  );
}

const ComposerImpl = lazySlot<ComposerSlotProps>(
  import.meta.glob<SlotModule>("./compose/Composer.tsx"),
  "Composer",
  FallbackComposer,
);
const AgentImpl = lazySlot<MailAgentPanelSlotProps>(
  import.meta.glob<SlotModule>("./agent/MailAgentPanel.tsx"),
  "MailAgentPanel",
  FallbackAgentPanel,
);

const loading = <div className="mail-slot-loading"><Spinner size={16} /></div>;

export function ComposerSlot(props: ComposerSlotProps) {
  return (
    <SlotBoundary name="Composer" fallback={<FallbackComposer {...props} />}>
      <Suspense fallback={loading}><ComposerImpl {...props} /></Suspense>
    </SlotBoundary>
  );
}

export function MailAgentPanelSlot(props: MailAgentPanelSlotProps) {
  return (
    <SlotBoundary name="MailAgentPanel" fallback={<FallbackAgentPanel {...props} />}>
      <Suspense fallback={loading}><AgentImpl {...props} /></Suspense>
    </SlotBoundary>
  );
}
