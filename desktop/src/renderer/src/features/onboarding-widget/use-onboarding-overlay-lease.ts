import { useEffect } from "react";
import { useUi } from "../../stores/ui";

/** Native app views paint above the renderer, so the expanded widget holds an overlay lease to stay visible. */
export function useOnboardingOverlayLease(expanded: boolean): void {
  const acquireRendererOverlay = useUi((state) => state.acquireRendererOverlay);
  const releaseRendererOverlay = useUi((state) => state.releaseRendererOverlay);
  useEffect(() => {
    if (!expanded) return;
    acquireRendererOverlay();
    return releaseRendererOverlay;
  }, [acquireRendererOverlay, expanded, releaseRendererOverlay]);
}
