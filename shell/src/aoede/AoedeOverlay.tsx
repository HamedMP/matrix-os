"use client";
import type { AoedeServerMessage } from "@matrix-os/contracts";
import { AoedeOverlayView } from "@matrix-os/ui/aoede";
import { useVocalStore } from "@/stores/vocal";
import { openProviderSettings } from "@/lib/canonical-provider-setup";
import { useAoedeSession } from "./useAoedeSession";
import type { UiResult } from "./shell-actions";

export function AoedeOverlay({ active, onUi }: {
  active: boolean; onUi: (frame: Extract<AoedeServerMessage, { type: "aoede:ui" }>) => UiResult;
}) {
  const session = useAoedeSession(active, onUi);
  return <AoedeOverlayView active={active} session={session}
    onDismiss={() => useVocalStore.getState().setActive(false)}
    onOpenSettings={openProviderSettings} />;
}
