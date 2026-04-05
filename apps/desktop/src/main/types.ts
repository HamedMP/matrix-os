import type { WebContentsView } from "electron"

export interface Tab {
  id: string
  appSlug: string
  title: string
  url: string
  view: WebContentsView | null
}

export interface SerializedTab {
  id: string
  appSlug: string
  url: string
  title: string
}

export interface TabInfo {
  id: string
  appSlug: string
  title: string
  active: boolean
}

export interface AppEntry {
  slug: string
  name: string
  icon: string
  category?: string
  description?: string
  builtIn: boolean
}

export type ConnectionStatus = "connected" | "starting" | "unreachable"

export interface ConnectionState {
  status: ConnectionStatus
  lastConnected: number | null
  consecutiveFailures: number
  containerVersion?: string
  updateAvailable?: boolean
}

export interface ContainerStatus {
  handle: string
  state: "running" | "stopped" | "starting" | "upgrading"
  imageVersion: string
  latestVersion?: string
  uptime?: number
}

export type ShortcutAction = "cmd-k" | "cmd-shift-f" | "cmd-r"
