import { GetStartedGate } from "@matrix-os/ui";
import { useMemo, type ReactNode } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { createDesktopGetStartedPort } from "./desktop-get-started-port";
import { useOnboardingOverlayLease } from "../onboarding-widget/use-onboarding-overlay-lease";
import { DesktopGetStartedConnector } from "./DesktopGetStartedConnector";

/** Native app views paint above the renderer, so the open wizard holds the overlay lease like the widget does. */
function GetStartedOverlayLease() {
  useOnboardingOverlayLease(true);
  return null;
}

/** Electron paints the wallpaper on the DesktopBackground layer. */
const desktopBackdrop = () => document.querySelector<HTMLElement>('[data-testid="desktop-background"]');

function DesktopGetStartedGate({ api, runtimeSlot, children }: { api: ApiClient; runtimeSlot: string; children: ReactNode }) {
  const port = useMemo(() => createDesktopGetStartedPort(api, runtimeSlot), [api, runtimeSlot]);
  return (
    <GetStartedGate port={port} zIndex={DESKTOP_Z_INDEX.getStarted} connector={DesktopGetStartedConnector} whileActive={GetStartedOverlayLease} backdropSource={desktopBackdrop}>
      {children}
    </GetStartedGate>
  );
}

/** Electron Desktop: the wizard runs first for a signed-in computer, then the onboarding widget it wraps. */
export default function GetStartedHost({ children }: { children: ReactNode }) {
  const status = useConnection((state) => state.status);
  const api = useConnection((state) => state.api);
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  if (status !== "signed-in" || !api || !handle) return <>{children}</>;
  // A computer or runtime switch starts a fresh check against the new gateway.
  return <DesktopGetStartedGate key={`${handle}:${runtimeSlot}`} api={api} runtimeSlot={runtimeSlot}>{children}</DesktopGetStartedGate>;
}
