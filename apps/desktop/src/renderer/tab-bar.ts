interface TabInfo {
  id: string
  appSlug: string
  title: string
  active: boolean
}

const tabBar = document.getElementById("tab-bar")!
let tabs: TabInfo[] = []

function render(): void {
  while (tabBar.firstChild) tabBar.removeChild(tabBar.firstChild)

  for (const tab of tabs) {
    const el = document.createElement("div")
    el.className = `tab ${tab.active ? "active" : ""}`
    el.style.cssText = `
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 12px;
      border-radius: 6px 6px 0 0;
      background: ${tab.active ? "var(--bg)" : "transparent"};
      color: ${tab.active ? "var(--text)" : "var(--text-secondary)"};
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
      max-width: 160px;
      position: relative;
    `

    const title = document.createElement("span")
    title.textContent = tab.title || tab.appSlug
    title.style.cssText = "overflow: hidden; text-overflow: ellipsis; flex: 1;"
    el.appendChild(title)

    const closeBtn = document.createElement("button")
    closeBtn.textContent = "\u00d7"
    closeBtn.style.cssText = `
      border: none;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 14px;
      padding: 0 2px;
      line-height: 1;
    `
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      window.electronAPI["tab:close"](tab.id)
    })
    el.appendChild(closeBtn)

    el.addEventListener("click", () => {
      window.electronAPI["tab:switch"](tab.id)
    })

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      showContextMenu(tab, e.clientX, e.clientY)
    })

    tabBar.appendChild(el)
  }

  const addBtn = document.createElement("button")
  addBtn.textContent = "+"
  addBtn.style.cssText = `
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 16px;
    padding: 4px 8px;
  `
  addBtn.addEventListener("click", () => {
    window.electronAPI["tab:create"]("terminal")
  })
  tabBar.appendChild(addBtn)
}

function showContextMenu(tab: TabInfo, x: number, y: number): void {
  const existing = document.getElementById("tab-context-menu")
  existing?.remove()

  const menu = document.createElement("div")
  menu.id = "tab-context-menu"
  menu.style.cssText = `
    position: fixed;
    left: ${x}px;
    top: ${y}px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 0;
    z-index: 9999;
    min-width: 140px;
  `

  const items = [
    { label: "Close", action: () => window.electronAPI["tab:close"](tab.id) },
    {
      label: "Close Others",
      action: () => {
        for (const t of tabs) {
          if (t.id !== tab.id) window.electronAPI["tab:close"](t.id)
        }
      },
    },
    {
      label: "Duplicate",
      action: () => window.electronAPI["tab:duplicate"](tab.id),
    },
    {
      label: "Reload",
      action: () => window.electronAPI["tab:reload"](tab.id),
    },
  ]

  for (const item of items) {
    const el = document.createElement("div")
    el.textContent = item.label
    el.style.cssText = `
      padding: 6px 12px;
      cursor: pointer;
      color: var(--text);
      font-size: 12px;
    `
    el.addEventListener("mouseenter", () => {
      el.style.background = "var(--border)"
    })
    el.addEventListener("mouseleave", () => {
      el.style.background = "transparent"
    })
    el.addEventListener("click", () => {
      item.action()
      menu.remove()
    })
    menu.appendChild(el)
  }

  document.body.appendChild(menu)

  const dismiss = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove()
      document.removeEventListener("click", dismiss)
    }
  }
  setTimeout(() => document.addEventListener("click", dismiss), 0)
}

window.electronAPI.onTabsChanged((newTabs) => {
  tabs = newTabs as TabInfo[]
  render()
})

window.electronAPI["tab:list"]().then((result) => {
  tabs = result as TabInfo[]
  render()
})
