import { contextBridge, ipcRenderer } from "electron";
import type { DesktopRuntimePolicy } from "../main/config.js";
import type { DesktopWorkbenchApp, DesktopWorkbenchSnapshot, DesktopWorkbenchTabInput } from "../main/index.js";

const matrixDesktop = {
  getRuntimePolicy: (): Promise<DesktopRuntimePolicy> =>
    ipcRenderer.invoke("matrix-desktop:get-runtime-policy") as Promise<DesktopRuntimePolicy>,
  openExternal: (url: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("matrix-desktop:open-external", url) as Promise<{ ok: boolean }>,
  getWorkbenchSnapshot: (): Promise<DesktopWorkbenchSnapshot> =>
    ipcRenderer.invoke("matrix-desktop:get-workbench-snapshot") as Promise<DesktopWorkbenchSnapshot>,
  listWorkbenchApps: (): Promise<DesktopWorkbenchApp[]> =>
    ipcRenderer.invoke("matrix-desktop:list-workbench-apps") as Promise<DesktopWorkbenchApp[]>,
  openWorkbenchTab: (input: DesktopWorkbenchTabInput): Promise<DesktopWorkbenchSnapshot> =>
    ipcRenderer.invoke("matrix-desktop:open-workbench-tab", input) as Promise<DesktopWorkbenchSnapshot>,
  focusWorkbenchTab: (id: string): Promise<DesktopWorkbenchSnapshot> =>
    ipcRenderer.invoke("matrix-desktop:focus-workbench-tab", id) as Promise<DesktopWorkbenchSnapshot>,
  closeWorkbenchTab: (id: string): Promise<DesktopWorkbenchSnapshot> =>
    ipcRenderer.invoke("matrix-desktop:close-workbench-tab", id) as Promise<DesktopWorkbenchSnapshot>,
  setWorkbenchChromeHeight: (height: number): Promise<DesktopWorkbenchSnapshot> =>
    ipcRenderer.invoke("matrix-desktop:set-workbench-chrome-height", height) as Promise<DesktopWorkbenchSnapshot>,
  onWorkbenchSnapshot: (callback: (snapshot: DesktopWorkbenchSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: DesktopWorkbenchSnapshot) => callback(snapshot);
    ipcRenderer.on("matrix-desktop:workbench-snapshot", listener);
    return () => ipcRenderer.removeListener("matrix-desktop:workbench-snapshot", listener);
  },
};

contextBridge.exposeInMainWorld("matrixDesktop", matrixDesktop);
