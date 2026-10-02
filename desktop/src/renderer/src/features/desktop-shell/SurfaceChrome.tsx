import { createContext, useContext, type ReactNode } from "react";

export interface SurfaceChromeSpec {
  title?: ReactNode;
  hideTitle?: boolean;
  leftActions?: ReactNode;
  rightActions?: ReactNode;
  leftPaneWidth?: number;
  rightPaneWidth?: number;
}

export interface SurfaceChromeHost {
  setChrome: (chrome: SurfaceChromeSpec | null) => void;
}

export const SurfaceChromeContext = createContext<SurfaceChromeHost | null>(null);

/** Only the verified Bot route supplies a target in the existing Chat toolbar. */
export const BotHeaderContext = createContext<HTMLElement | null>(null);

export function useSurfaceChromeHost(): SurfaceChromeHost | null {
  return useContext(SurfaceChromeContext);
}
