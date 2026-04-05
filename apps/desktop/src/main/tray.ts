import { Tray, Menu, app, type MenuItemConstructorOptions } from "electron"
import type { ConnectionState, ConnectionStatus } from "./types.js"

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: "Connected",
  starting: "Starting...",
  unreachable: "Unreachable",
}

export class TrayManager {
  private tray: Tray
  onContainerStart?: () => Promise<void>
  onContainerStop?: () => Promise<void>
  onContainerUpgrade?: () => Promise<void>

  constructor(iconPath: string) {
    this.tray = new Tray(iconPath)
    this.tray.setToolTip("Matrix OS")
  }

  updateMenu(state: ConnectionState): void {
    const statusLabel = STATUS_LABELS[state.status]
    const isConnected = state.status === "connected"
    const isUnreachable = state.status === "unreachable"

    const template: MenuItemConstructorOptions[] = [
      { label: "Matrix OS", enabled: false },
      { label: "Status: " + statusLabel, enabled: false },
      { type: "separator" },
      {
        label: "Open Matrix OS",
        click: () => {
          app.focus?.()
        },
      },
      { type: "separator" },
      {
        label: "Start Container",
        visible: isUnreachable,
        click: async () => {
          await this.onContainerStart?.()
        },
      },
      {
        label: "Stop Container",
        visible: isConnected,
        click: async () => {
          await this.onContainerStop?.()
        },
      },
      {
        label: "Upgrade Container",
        visible: isConnected,
        click: async () => {
          await this.onContainerUpgrade?.()
        },
      },
      { type: "separator" },
      {
        label: "About Matrix OS",
        click: () => {
          app.showAboutPanel?.()
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        accelerator: "CmdOrCtrl+Q",
        click: () => {
          app.quit()
        },
      },
    ]

    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  destroy(): void {
    this.tray?.destroy()
  }
}
