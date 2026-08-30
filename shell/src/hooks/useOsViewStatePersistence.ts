"use client";

import { useEffect } from "react";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { patchWebOsViewState } from "@/lib/os-view-state-client";
import { useDesktopMode } from "@/stores/desktop-mode";

export function useCanvasTransformPersistence(gatewayUrl: string): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useCanvasTransform.subscribe(
      (state) => ({ zoom: state.zoom, panX: state.panX, panY: state.panY }),
      (transform) => {
        if (useDesktopMode.getState().mode !== "canvas") return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          void patchWebOsViewState(gatewayUrl, { canvas: { transform } }).catch((error: unknown) => {
            console.warn("[os-view-state] Canvas transform persist failed:", error instanceof Error ? error.name : "UnknownError");
          });
        }, 500);
      },
      { equalityFn: (left, right) => left.zoom === right.zoom && left.panX === right.panX && left.panY === right.panY },
    );
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [gatewayUrl]);
}
