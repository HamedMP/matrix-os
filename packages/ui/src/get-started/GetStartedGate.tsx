import type { ReactNode } from "react";
import { useGettingStartedAutoOpenSuppression, useGettingStartedBlocker } from "../getting-started-visibility.js";
import { GetStartedWizard } from "./GetStartedWizard.js";
import { useGetStarted, type GetStartedPort } from "./use-get-started.js";

export interface GetStartedGateProps {
  port: GetStartedPort;
  /** The surface's layer for full-window setup overlays: above windows and the dock, below hard gates. */
  zIndex: number;
  /** The onboarding widget: held back until the wizard is finished or not needed. */
  children?: ReactNode;
}

/**
 * Spec 635: shows the Get started wizard once on a new computer, over the blurred desktop.
 * It cannot be closed or minimized; it ends only when the owner finishes or skips it.
 * Any load failure falls back to today's desktop.
 */
export function GetStartedGate({ port, zIndex, children }: GetStartedGateProps) {
  const getStarted = useGetStarted(port);
  const active = getStarted.phase === "active";
  useGettingStartedBlocker(active);
  useGettingStartedAutoOpenSuppression(getStarted.phase !== "done");

  if (getStarted.phase === "loading") return null;
  if (getStarted.phase === "done" || !getStarted.wizard) return <>{children}</>;
  return (
    <div className="mxo-root mxo-gs ph-no-capture" style={{ zIndex }}>
      <div className="mxo-gs__scrim" aria-hidden />
      <GetStartedWizard
        wizard={getStarted.wizard}
        submitting={getStarted.submitting}
        error={getStarted.error}
        dispatch={getStarted.dispatch}
        onFinish={getStarted.finish}
        onSkipAll={getStarted.skipAll}
      />
    </div>
  );
}
