/// <reference path="../preload/index.d.ts" />

import type { DesktopWorkbenchApp, DesktopWorkbenchSnapshot, DesktopWorkbenchTab } from "../main/index.js";

const NORMAL_CHROME_HEIGHT = 116;
const LAUNCHER_CHROME_HEIGHT = 428;

const root = document.getElementById("app");
const desktop = window.matrixDesktop;

let apps: DesktopWorkbenchApp[] = [];
let snapshot: DesktopWorkbenchSnapshot = { activeTabId: null, chromeHeight: NORMAL_CHROME_HEIGHT, tabs: [] };
let launcherOpen = false;
let appFilter = "";

const APP_COPY: Record<string, { description: string; action: string; accent: string }> = {
  shell: { description: "Full Matrix OS canvas and desktop shell.", action: "Open shell", accent: "ivory" },
  workspace: { description: "Cloud projects, tickets, previews, sessions, and reviews.", action: "Command center", accent: "blue" },
  terminal: { description: "Persistent Matrix terminal session in a native desktop tab.", action: "New terminal", accent: "amber" },
  files: { description: "Browse owner-controlled Matrix files and app assets.", action: "Open files", accent: "coral" },
  chat: { description: "Talk to the Matrix kernel and route work to agents.", action: "Open chat", accent: "violet" },
  symphony: { description: "Assign tickets to Symphony and monitor cloud agent runs.", action: "Open runner", accent: "mint" },
  "task-manager": { description: "Kanban board for Linear and Matrix-native tickets.", action: "Open board", accent: "rose" },
};

function appMeta(app: DesktopWorkbenchApp): { description: string; action: string; accent: string } {
  return APP_COPY[app.id] ?? {
    description: app.defaultApp ? "Default Matrix app surface." : "Installed Matrix application.",
    action: "Open app",
    accent: "ivory",
  };
}

function kindLabel(kind: DesktopWorkbenchApp["kind"] | DesktopWorkbenchTab["kind"]): string {
  if (kind === "file-browser") return "Files";
  return kind[0].toUpperCase() + kind.slice(1);
}

function categoryLabel(category: string): string {
  return category.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function tabLabel(tab: DesktopWorkbenchTab): string {
  return tab.title.trim().replace(/^Matrix OS\s*[|-]\s*/i, "") || "Matrix";
}

function activeTab(): DesktopWorkbenchTab | undefined {
  return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createButton(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = createEl("button", className, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function setLauncherOpen(nextOpen: boolean): void {
  launcherOpen = nextOpen;
  void desktop?.setWorkbenchChromeHeight(nextOpen ? LAUNCHER_CHROME_HEIGHT : NORMAL_CHROME_HEIGHT);
  render();
}

function openWorkbenchTab(title: string, url: string, kind: DesktopWorkbenchTab["kind"]): void {
  void desktop?.openWorkbenchTab({ title, url, kind }).then(updateSnapshot);
}

function openApp(app: DesktopWorkbenchApp): void {
  openWorkbenchTab(app.name, app.url, app.kind);
  setLauncherOpen(false);
}

function openTerminalTab(): void {
  const session = Date.now().toString(36);
  openWorkbenchTab("Terminal", `/desktop/terminal?session=${session}`, "terminal");
}

function updateSnapshot(nextSnapshot: DesktopWorkbenchSnapshot): void {
  snapshot = nextSnapshot;
  render();
}

function visibleApps(): DesktopWorkbenchApp[] {
  const query = appFilter.trim().toLowerCase();
  if (!query) return apps;
  return apps.filter((app) =>
    app.name.toLowerCase().includes(query) ||
    app.category.toLowerCase().includes(query) ||
    appMeta(app).description.toLowerCase().includes(query));
}

function appendStatusPill(container: HTMLElement, label: string, value: string, tone = ""): void {
  const pill = createEl("div", `statusPill ${tone}`);
  pill.append(createEl("span", "statusLabel", label), createEl("span", "statusValue", value));
  container.appendChild(pill);
}

function renderRail(container: HTMLElement): void {
  const rail = createEl("nav", "rail");
  rail.appendChild(createEl("div", "railMark", "M"));

  const buttons: Array<{ label: string; title: string; active?: boolean; onClick: () => void }> = [
    { label: "W", title: "Workspace", onClick: () => openWorkbenchTab("Workspace", "/desktop/workspace", "workspace") },
    { label: "T", title: "Terminal", active: activeTab()?.kind === "terminal", onClick: openTerminalTab },
    { label: "S", title: "Symphony", onClick: () => openWorkbenchTab("Symphony", "/desktop/apps/symphony", "app") },
    { label: "K", title: "Task Manager", onClick: () => openWorkbenchTab("Task Manager", "/desktop/apps/task-manager", "app") },
  ];

  const buttonWrap = createEl("div", "railButtons");
  for (const item of buttons) {
    const button = createButton(item.active ? "railButton active" : "railButton", item.label, item.onClick);
    button.title = item.title;
    buttonWrap.appendChild(button);
  }
  rail.appendChild(buttonWrap);
  rail.appendChild(createButton(launcherOpen ? "railButton launcher active" : "railButton launcher", "+", () => setLauncherOpen(!launcherOpen)));
  container.appendChild(rail);
}

function renderTabs(container: HTMLElement): void {
  const tabs = createEl("div", "tabs");

  for (const tab of snapshot.tabs) {
    const tabButton = createEl("button", tab.id === snapshot.activeTabId ? `tab active ${tab.kind}` : `tab ${tab.kind}`) as HTMLButtonElement;
    tabButton.type = "button";
    tabButton.title = tabLabel(tab);
    tabButton.addEventListener("click", () => {
      void desktop?.focusWorkbenchTab(tab.id).then(updateSnapshot);
    });

    tabButton.appendChild(createEl("span", "tabKind"));
    const text = createEl("span", "tabText");
    text.append(createEl("span", "tabTitle", tabLabel(tab)), createEl("span", "tabMeta", kindLabel(tab.kind)));
    tabButton.appendChild(text);

    if (tab.loading) tabButton.appendChild(createEl("span", "tabLoading"));

    if (snapshot.tabs.length > 1) {
      const close = createEl("span", "tabClose", "x");
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void desktop?.closeWorkbenchTab(tab.id).then(updateSnapshot);
      });
      tabButton.appendChild(close);
    }

    tabs.appendChild(tabButton);
  }

  container.appendChild(tabs);
}

function groupedApps(): Array<{ category: string; entries: DesktopWorkbenchApp[] }> {
  const groups: Array<{ category: string; entries: DesktopWorkbenchApp[] }> = [];
  for (const app of visibleApps()) {
    const existing = groups.find((group) => group.category === app.category);
    if (existing) existing.entries.push(app);
    else groups.push({ category: app.category, entries: [app] });
  }
  return groups;
}

function renderLauncher(container: HTMLElement): void {
  if (!launcherOpen) return;

  const launcher = createEl("section", "launcher");
  const header = createEl("div", "launcherHeader");
  const copy = createEl("div", "launcherCopy");
  copy.append(
    createEl("span", "eyebrow", "Cloud agent command center"),
    createEl("h2", undefined, "Launch a surface, then keep it alive in its own desktop tab"),
  );

  const search = createEl("input", "launcherSearch") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "Search apps, terminals, tickets";
  search.value = appFilter;
  search.addEventListener("input", () => {
    appFilter = search.value;
    render();
    const nextSearch = document.querySelector<HTMLInputElement>(".launcherSearch");
    nextSearch?.focus();
    nextSearch?.setSelectionRange(appFilter.length, appFilter.length);
  });

  header.append(copy, search);
  launcher.appendChild(header);

  const body = createEl("div", "launcherBody");
  for (const { category, entries } of groupedApps()) {
    const section = createEl("section", "launcherGroup");
    section.appendChild(createEl("div", "launcherGroupTitle", categoryLabel(category)));

    const grid = createEl("div", "appGrid");
    for (const app of entries) {
      const meta = appMeta(app);
      const tile = createEl("button", `appTile ${meta.accent}`) as HTMLButtonElement;
      tile.type = "button";
      tile.addEventListener("click", () => openApp(app));

      const icon = createEl("span", "appBadge", app.name.slice(0, 1).toUpperCase());
      const text = createEl("span", "appCopy");
      text.append(createEl("span", "appName", app.name), createEl("span", "appDescription", meta.description));

      const action = createEl("span", "appAction");
      action.append(createEl("span", "appKind", kindLabel(app.kind)), createEl("span", "appActionLabel", meta.action));
      tile.append(icon, text, action);
      grid.appendChild(tile);
    }

    section.appendChild(grid);
    body.appendChild(section);
  }

  if (body.childElementCount === 0) body.appendChild(createEl("div", "emptyLauncher", "No matching apps or workflows"));
  launcher.appendChild(body);
  container.appendChild(launcher);
}

function renderHeader(container: HTMLElement): void {
  const header = createEl("div", "topBar");
  const identity = createEl("div", "identity");
  identity.append(createEl("div", "brand", "Matrix Desktop"), createEl("div", "tagline", "Cloud-first agent OS"));

  const status = createEl("div", "statusCluster");
  appendStatusPill(status, "Runtime", "Cloud", "mint");
  appendStatusPill(status, "Tabs", String(snapshot.tabs.length), "amber");
  appendStatusPill(status, "Active", activeTab() ? kindLabel(activeTab()!.kind) : "Shell");

  const actions = createEl("div", "actions");
  actions.append(
    createButton(launcherOpen ? "toolbarButton active" : "toolbarButton", "Launcher", () => setLauncherOpen(!launcherOpen)),
    createButton("toolbarButton primary", "New Terminal", openTerminalTab),
    createButton("toolbarButton", "Shell", () => openWorkbenchTab("Matrix Shell", "/", "shell")),
  );

  header.append(identity, status, actions);
  container.appendChild(header);
}

function renderChrome(): HTMLElement {
  const frame = createEl("div", launcherOpen ? "frame launcherOpen" : "frame");
  renderRail(frame);

  const chrome = createEl("header", "chrome");
  renderHeader(chrome);

  const tabRow = createEl("div", "tabRow");
  renderTabs(tabRow);
  chrome.appendChild(tabRow);
  renderLauncher(chrome);

  frame.appendChild(chrome);
  return frame;
}

function renderFallback(): void {
  if (!root) return;
  root.replaceChildren();
  root.appendChild(createEl("div", "fallback", "Matrix Desktop preload is unavailable."));
}

function render(): void {
  if (!root || !desktop) return;
  root.replaceChildren(renderChrome());
}

if (!root || !desktop) {
  renderFallback();
} else {
  desktop.onWorkbenchSnapshot(updateSnapshot);
  void desktop.getWorkbenchSnapshot().then(updateSnapshot);
  void desktop.listWorkbenchApps().then((entries: DesktopWorkbenchApp[]) => {
    apps = entries;
    render();
  });
}
