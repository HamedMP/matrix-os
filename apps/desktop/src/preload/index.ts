import { contextBridge, ipcRenderer } from "electron"

const matrixDesktop = {
  isDesktop: true as const,
  version: "0.1.0",

  onShortcut(cb: (action: string) => void): void {
    ipcRenderer.on("shortcut", (_event, action: string) => cb(action))
  },

  async getConnectionInfo(): Promise<{
    status: string
    handle: string
  }> {
    return ipcRenderer.invoke("desktop:getConnectionInfo")
  },

  async requestUpgrade(): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke("desktop:requestUpgrade")
  },
}

contextBridge.exposeInMainWorld("matrixDesktop", matrixDesktop)
