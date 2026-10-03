import { createContext, useContext, type ReactNode } from "react";
import type { useDirectBotBinding } from "@matrix-os/ui";

export interface SurfaceChromeSpec {
  title?: ReactNode;
  hideTitle?: boolean;
  /** A content view may opt into the shared toolbar even when its app owns sidebar chrome. */
  showTitle?: boolean;
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

export interface BotHeaderBindingReport {
  chatId: string;
  client: object;
  status: ReturnType<typeof useDirectBotBinding>["status"];
  agentId: string | null;
}

/** Content reports its authenticated binding into the current host scope only. */
export const BotHeaderBindingContext = createContext<((binding: BotHeaderBindingReport) => () => void) | null>(null);

export function useSurfaceChromeHost(): SurfaceChromeHost | null {
  return useContext(SurfaceChromeContext);
}
