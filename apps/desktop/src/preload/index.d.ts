import type { DesktopRuntimePolicy } from "../main/config.js";
import type { DesktopWorkbenchApp, DesktopWorkbenchSnapshot, DesktopWorkbenchTabInput } from "../main/index.js";

declare global {
  interface Window {
    matrixDesktop?: {
      getRuntimePolicy: () => Promise<DesktopRuntimePolicy>;
      openExternal: (url: string) => Promise<{ ok: boolean }>;
      getWorkbenchSnapshot: () => Promise<DesktopWorkbenchSnapshot>;
      listWorkbenchApps: () => Promise<DesktopWorkbenchApp[]>;
      openWorkbenchTab: (input: DesktopWorkbenchTabInput) => Promise<DesktopWorkbenchSnapshot>;
      focusWorkbenchTab: (id: string) => Promise<DesktopWorkbenchSnapshot>;
      closeWorkbenchTab: (id: string) => Promise<DesktopWorkbenchSnapshot>;
      setWorkbenchChromeHeight: (height: number) => Promise<DesktopWorkbenchSnapshot>;
      onWorkbenchSnapshot: (callback: (snapshot: DesktopWorkbenchSnapshot) => void) => () => void;
    };
  }
}

export {};
