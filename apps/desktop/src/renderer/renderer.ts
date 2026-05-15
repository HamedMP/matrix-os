/// <reference path="../preload/index.d.ts" />

import type { DesktopWorkbenchApp, DesktopWorkbenchSnapshot, DesktopWorkbenchTab } from "../main/index.js";

const NORMAL_CHROME_HEIGHT = 108;
const LAUNCHER_CHROME_HEIGHT = 392;

const root = document.getElementById("app");
const desktop = window.matrixDesktop;

let apps: DesktopWorkbenchApp[] = [];
let snapshot: DesktopWorkbenchSnapshot = { activeTabId: null, chromeHeight: NORMAL_CHROME_HEIGHT, tabs: [] };
let launcherOpen = false;
let appFilter = "";

function appKindLabel(kind: DesktopWorkbenchApp["kind"]): string {
  if (kind === "file-browser") return "Files";
  return kind[0].toUpperCase() + kind.slice(1);
}

function categoryLabel(category: string): string {
  return category.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function tabLabel(tab: DesktopWorkbenchTab): string {
  return tab.title.trim() || "Matrix";
}

function createButton(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function setLauncherOpen(nextOpen: boolean): void {
  launcherOpen = nextOpen;
  void desktop?.setWorkbenchChromeHeight(nextOpen ? LAUNCHER_CHROME_HEIGHT : NORMAL_CHROME_HEIGHT);
  render();
}

function openApp(app: DesktopWorkbenchApp): void {
  void desktop?.openWorkbenchTab({ title: app.name, url: app.url, kind: app.kind }).then(updateSnapshot);
  setLauncherOpen(false);
}

function openTerminalTab(): void {
  const session = Date.now().toString(36);
  void desktop?.openWorkbenchTab({
    title: "Terminal",
    url: `/desktop/terminal?session=${session}`,
    kind: "terminal",
  }).then(updateSnapshot);
}

function updateSnapshot(nextSnapshot: DesktopWorkbenchSnapshot): void {
  snapshot = nextSnapshot;
  render();
}

function visibleApps(): DesktopWorkbenchApp[] {
  const query = appFilter.trim().toLowerCase();
  if (!query) return apps;
  return apps.filter((app) => app.name.toLowerCase().includes(query) || app.category.toLowerCase().includes(query));
}

function renderTabs(container: HTMLElement): void {
  const tabs = document.createElement("div");
  tabs.className = "tabs";

  for (const tab of snapshot.tabs) {
    const tabButton = document.createElement("button");
    tabButton.type = "button";
    tabButton.className = tab.id === snapshot.activeTabId ? "tab active" : "tab";
    tabButton.title = tabLabel(tab);
    tabButton.addEventListener("click", () => {
      void desktop?.focusWorkbenchTab(tab.id).then(updateSnapshot);
    });

    const title = document.createElement("span");
    title.className = "tabTitle";
    title.textContent = tabLabel(tab);
    tabButton.appendChild(title);

    if (tab.loading) {
      const loading = document.createElement("span");
      loading.className = "tabLoading";
      tabButton.appendChild(loading);
    }

    if (snapshot.tabs.length > 1) {
      const close = document.createElement("span");
      close.className = "tabClose";
      close.textContent = "x";
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

function renderLauncher(container: HTMLElement): void {
  if (!launcherOpen) return;

  const launcher = document.createElement("section");
  launcher.className = "launcher";

  const header = document.createElement("div");
  header.className = "launcherHeader";

  const title = document.createElement("div");
  title.className = "launcherTitle";
  title.textContent = "Launcher";
  header.appendChild(title);

  const search = document.createElement("input");
  search.className = "launcherSearch";
  search.type = "search";
  search.placeholder = "Search apps";
  search.value = appFilter;
  search.addEventListener("input", () => {
    appFilter = search.value;
    render();
    document.querySelector<HTMLInputElement>(".launcherSearch")?.focus();
  });
  header.appendChild(search);
  launcher.appendChild(header);

  const groups: Array<{ category: string; entries: DesktopWorkbenchApp[] }> = [];
  for (const app of visibleApps()) {
    const existing = groups.find((group) => group.category === app.category);
    if (existing) {
      existing.entries.push(app);
    } else {
      groups.push({ category: app.category, entries: [app] });
    }
  }

  const grid = document.createElement("div");
  grid.className = "launcherGrid";
  for (const { category, entries } of groups) {
    const section = document.createElement("section");
    section.className = "launcherGroup";

    const groupTitle = document.createElement("div");
    groupTitle.className = "launcherGroupTitle";
    groupTitle.textContent = categoryLabel(category);
    section.appendChild(groupTitle);

    const appGrid = document.createElement("div");
    appGrid.className = "appGrid";
    for (const app of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "appTile";
      button.addEventListener("click", () => openApp(app));

      const badge = document.createElement("span");
      badge.className = `appBadge ${app.kind}`;
      badge.textContent = app.name.slice(0, 1).toUpperCase();
      button.appendChild(badge);

      const copy = document.createElement("span");
      copy.className = "appCopy";

      const name = document.createElement("span");
      name.className = "appName";
      name.textContent = app.name;
      copy.appendChild(name);

      const meta = document.createElement("span");
      meta.className = "appMeta";
      meta.textContent = app.defaultApp ? `${appKindLabel(app.kind)} - Default` : appKindLabel(app.kind);
      copy.appendChild(meta);

      button.appendChild(copy);
      appGrid.appendChild(button);
    }

    section.appendChild(appGrid);
    grid.appendChild(section);
  }

  if (groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "emptyLauncher";
    empty.textContent = "No apps found";
    grid.appendChild(empty);
  }

  launcher.appendChild(grid);
  container.appendChild(launcher);
}

function renderChrome(): HTMLElement {
  const chrome = document.createElement("header");
  chrome.className = launcherOpen ? "chrome launcherOpen" : "chrome";

  const topBar = document.createElement("div");
  topBar.className = "topBar";

  const brand = document.createElement("div");
  brand.className = "brand";
  brand.textContent = "Matrix";
  topBar.appendChild(brand);

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(createButton(launcherOpen ? "toolbarButton active" : "toolbarButton", "Launcher", () => setLauncherOpen(!launcherOpen)));
  actions.appendChild(createButton("toolbarButton", "Terminal", openTerminalTab));
  actions.appendChild(createButton("toolbarButton subtle", "Shell", () => {
    void desktop?.openWorkbenchTab({ title: "Matrix Shell", url: "/", kind: "shell" }).then(updateSnapshot);
  }));
  topBar.appendChild(actions);

  chrome.appendChild(topBar);

  const tabRow = document.createElement("div");
  tabRow.className = "tabRow";
  renderTabs(tabRow);
  chrome.appendChild(tabRow);
  renderLauncher(chrome);
  return chrome;
}

function renderFallback(): void {
  if (!root) return;
  root.replaceChildren();
  const fallback = document.createElement("div");
  fallback.className = "fallback";
  fallback.textContent = "Matrix Desktop preload is unavailable.";
  root.appendChild(fallback);
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
