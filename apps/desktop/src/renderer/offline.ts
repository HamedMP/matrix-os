let overlay: HTMLElement | null = null

function createOverlay(): HTMLElement {
  const el = document.createElement("div")
  el.id = "offline-overlay"
  el.style.cssText = `
    position: fixed;
    inset: 0;
    background: var(--bg);
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    z-index: 10000;
  `

  const icon = document.createElement("div")
  icon.textContent = "\u25c9"
  icon.style.cssText = "font-size: 48px; opacity: 0.5;"
  el.appendChild(icon)

  const heading = document.createElement("h2")
  heading.textContent = "Your instance is unreachable"
  heading.style.cssText = "font-size: 18px; font-weight: 600;"
  el.appendChild(heading)

  const lastConnected = document.createElement("p")
  lastConnected.id = "offline-last-connected"
  lastConnected.style.cssText = "color: var(--text-secondary); font-size: 13px;"
  el.appendChild(lastConnected)

  const btnContainer = document.createElement("div")
  btnContainer.style.cssText = "display: flex; gap: 8px; margin-top: 8px;"

  const retryBtn = document.createElement("button")
  retryBtn.id = "offline-retry"
  retryBtn.textContent = "Retry"
  retryBtn.style.cssText = `
    padding: 8px 16px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--accent);
    color: white;
    cursor: pointer;
    font-size: 13px;
  `
  btnContainer.appendChild(retryBtn)
  el.appendChild(btnContainer)

  document.body.appendChild(el)
  return el
}

function showOffline(lastConnected: number | null): void {
  if (!overlay) overlay = createOverlay()
  overlay.style.display = "flex"

  const el = document.getElementById("offline-last-connected")
  if (el && lastConnected) {
    const ago = Math.round((Date.now() - lastConnected) / 1000)
    el.textContent =
      ago < 60
        ? `Last connected: ${ago}s ago`
        : `Last connected: ${Math.round(ago / 60)}m ago`
  }
}

function hideOffline(): void {
  if (overlay) overlay.style.display = "none"
}

window.electronAPI.onConnectionChanged((state: unknown) => {
  const s = state as { status: string; lastConnected: number | null }
  if (s.status === "unreachable") {
    showOffline(s.lastConnected)
  } else {
    hideOffline()
  }
})

document.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "offline-retry") {
    window.electronAPI["container:status"]()
  }
})
