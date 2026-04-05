declare global {
  interface Window {
    electronAPI: Record<string, (...args: unknown[]) => Promise<unknown>> & {
      onConnectionChanged: (cb: (state: unknown) => void) => void
      onTabsChanged: (cb: (tabs: unknown[]) => void) => void
      onAppsChanged: (cb: (apps: unknown[]) => void) => void
      onUpgradeProgress: (cb: (status: string) => void) => void
    }
  }
}

interface AppEntry {
  slug: string
  name: string
  icon: string
  builtIn: boolean
}

const sidebar = document.getElementById("sidebar")!
let apps: AppEntry[] = []
let pinned: string[] = []

async function loadApps(): Promise<void> {
  try {
    apps = (await window.electronAPI["sidebar:getApps"]()) as AppEntry[]
    render()
  } catch {
    // Health monitor will handle connection issues
  }
}

function render(): void {
  while (sidebar.firstChild) sidebar.removeChild(sidebar.firstChild)

  const pinnedApps = pinned
    .map((slug) => apps.find((a) => a.slug === slug))
    .filter(Boolean) as AppEntry[]
  const unpinnedApps = apps.filter((a) => !pinned.includes(a.slug))

  for (const app of [...pinnedApps, ...unpinnedApps]) {
    const btn = document.createElement("button")
    btn.className = "sidebar-item"
    btn.title = app.name
    btn.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 16px;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 13px;
    `

    const img = document.createElement("img")
    img.src = app.icon
    img.alt = app.name
    img.width = 24
    img.height = 24
    img.style.borderRadius = "6px"
    img.onerror = () => {
      img.style.display = "none"
    }

    const label = document.createElement("span")
    label.textContent = app.name
    label.style.whiteSpace = "nowrap"

    btn.appendChild(img)
    btn.appendChild(label)

    btn.addEventListener("click", () => {
      window.electronAPI["tab:create"](app.slug)
    })

    sidebar.appendChild(btn)
  }

  const spacer = document.createElement("div")
  spacer.style.flex = "1"
  sidebar.appendChild(spacer)

  const status = document.createElement("div")
  status.id = "connection-dot"
  status.style.cssText = `
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--green);
    margin: 12px auto;
  `
  sidebar.appendChild(status)
}

window.electronAPI.onAppsChanged((newApps) => {
  apps = newApps as AppEntry[]
  render()
})

window.electronAPI.onConnectionChanged((state: unknown) => {
  const s = state as { status: string }
  const dot = document.getElementById("connection-dot")
  if (!dot) return
  const colors: Record<string, string> = {
    connected: "var(--green)",
    starting: "var(--yellow)",
    unreachable: "var(--red)",
  }
  dot.style.background = colors[s.status] ?? "var(--red)"
})

loadApps()
