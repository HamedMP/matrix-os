"use client"

import { useEffect, useState } from "react"

interface MatrixDesktopAPI {
  isDesktop: true
  version: string
  onShortcut: (cb: (action: string) => void) => void
  getConnectionInfo: () => Promise<{ status: string; handle: string }>
  requestUpgrade: () => Promise<{ success: boolean; error?: string }>
}

declare global {
  interface Window {
    matrixDesktop?: MatrixDesktopAPI
  }
}

export function useNativeDesktop() {
  const [isEmbedded, setIsEmbedded] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const hasParam = params.get("desktop") === "1"
    const hasAPI = typeof window.matrixDesktop !== "undefined"
    setIsEmbedded(hasParam || hasAPI)
  }, [])

  useEffect(() => {
    if (!isEmbedded || !window.matrixDesktop) return

    window.matrixDesktop.onShortcut((action: string) => {
      switch (action) {
        case "cmd-k": {
          const event = new KeyboardEvent("keydown", {
            key: "k",
            metaKey: true,
            bubbles: true,
          })
          document.dispatchEvent(event)
          break
        }
        case "cmd-shift-f": {
          const event = new KeyboardEvent("keydown", {
            key: "f",
            metaKey: true,
            shiftKey: true,
            bubbles: true,
          })
          document.dispatchEvent(event)
          break
        }
      }
    })
  }, [isEmbedded])

  return { isEmbedded }
}
