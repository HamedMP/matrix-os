import Store from "electron-store"
import type { SerializedTab } from "./types.js"

export interface StoreSchema {
  tabs: SerializedTab[]
  activeTabId: string | null
  sidebarPinned: string[]
  sidebarExpanded: boolean
  windowBounds: {
    x: number
    y: number
    width: number
    height: number
    maximized: boolean
  }
}

const defaults: StoreSchema = {
  tabs: [],
  activeTabId: null,
  sidebarPinned: ["terminal", "chat", "files"],
  sidebarExpanded: false,
  windowBounds: {
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
    maximized: false,
  },
}

let storeInstance: Store<StoreSchema> | null = null

export function getStore(): Store<StoreSchema> {
  if (!storeInstance) {
    storeInstance = new Store<StoreSchema>({ defaults })
  }
  return storeInstance
}

export function createStore(
  overrides?: Partial<{ defaults: StoreSchema }>,
): Store<StoreSchema> {
  return new Store<StoreSchema>({
    defaults: overrides?.defaults ?? defaults,
  })
}

export { defaults as storeDefaults }
