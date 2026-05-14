import type { DesktopRuntimePolicy } from "../main/config.js";

declare global {
  interface Window {
    matrixDesktop?: {
      getRuntimePolicy: () => Promise<DesktopRuntimePolicy>;
      openExternal: (url: string) => Promise<{ ok: boolean }>;
    };
  }
}

export {};
