import { autoUpdater } from "electron-updater"
import { is } from "@electron-toolkit/utils"

const CHECK_INTERVAL = 4 * 60 * 60 * 1000 // 4 hours

export interface UpdateCallbacks {
  onUpdateAvailable?: (version: string) => void
  onDownloadProgress?: (percent: number) => void
  onUpdateDownloaded?: (version: string) => void
}

export function initAutoUpdater(callbacks: UpdateCallbacks): void {
  if (is.dev) return

  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on("update-available", (info) => {
    callbacks.onUpdateAvailable?.(info.version)
  })

  autoUpdater.on("download-progress", (progress) => {
    callbacks.onDownloadProgress?.(progress.percent)
  })

  autoUpdater.on("update-downloaded", (info) => {
    callbacks.onUpdateDownloaded?.(info.version)
  })

  autoUpdater.checkForUpdates()

  setInterval(() => {
    autoUpdater.checkForUpdates()
  }, CHECK_INTERVAL)
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}
