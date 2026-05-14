import { contextBridge, ipcRenderer } from "electron";
import type { DesktopRuntimePolicy } from "../main/config.js";

const matrixDesktop = {
  getRuntimePolicy: (): Promise<DesktopRuntimePolicy> =>
    ipcRenderer.invoke("matrix-desktop:get-runtime-policy") as Promise<DesktopRuntimePolicy>,
  openExternal: (url: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("matrix-desktop:open-external", url) as Promise<{ ok: boolean }>,
};

contextBridge.exposeInMainWorld("matrixDesktop", matrixDesktop);
