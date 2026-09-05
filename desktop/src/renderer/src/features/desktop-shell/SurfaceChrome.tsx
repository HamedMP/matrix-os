import { createContext, useContext, type ReactNode } from "react";

export interface SurfaceChromeSpec {
  title?: ReactNode;
  leftActions?: ReactNode;
  rightActions?: ReactNode;
  leftPaneWidth?: number;
  rightPaneWidth?: number;
}

export interface SurfaceChromeHost {
  setChrome: (chrome: SurfaceChromeSpec | null) => void;
}

export const SurfaceChromeContext = createContext<SurfaceChromeHost | null>(null);

export function useSurfaceChromeHost(): SurfaceChromeHost | null {
  return useContext(SurfaceChromeContext);
}
