import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  PanelLeft,
} from "lucide-react";
import { Fragment } from "react";
import { useHermesChat } from "../../stores/hermes-chat";
import { useTabs, type Tab } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";
import { useUi } from "../../stores/ui";
import { DESKTOP_Z_INDEX } from "../../design/layering";

interface BreadcrumbItem {
  key: string;
  label: string;
}

export function breadcrumbItemsForTab(
  tab: Tab | undefined,
  conversationTitle?: string,
): BreadcrumbItem[] {
  if (!tab) return [];
  switch (tab.kind) {
    case "projects":
      return [
        { key: "home", label: "Home" },
        { key: "projects", label: "Projects" },
      ];
    case "project":
      return [
        { key: "home", label: "Home" },
        { key: "projects", label: "Projects" },
        { key: `projects/${tab.projectSlug ?? tab.id}`, label: tab.title },
      ];
    case "task":
      return [
        { key: "home", label: "Home" },
        { key: "projects", label: "Projects" },
        {
          key: `projects/${tab.projectSlug ?? "project"}`,
          label: tab.projectSlug ?? "Project",
        },
        {
          key: `projects/${tab.projectSlug ?? "project"}/tasks/${tab.taskId ?? tab.id}`,
          label: tab.title,
        },
      ];
    case "terminal":
      return [
        { key: "terminal", label: "Terminal" },
        {
          key: `terminal/${tab.sessionName ?? tab.id}`,
          label: tab.sessionName ?? tab.title,
        },
      ];
    case "terminals":
      return tab.title === "Terminal"
        ? [{ key: "terminal", label: "Terminal" }]
        : [
            { key: "terminal", label: "Terminal" },
            { key: `terminal/${tab.title}`, label: tab.title },
          ];
    case "app":
      return [
        { key: "apps", label: "Apps" },
        { key: `apps/${tab.slug ?? tab.id}`, label: tab.title },
      ];
    case "chat":
      return conversationTitle
        ? [
            { key: "chat", label: "Chat" },
            { key: `chat/${tab.id}`, label: conversationTitle },
          ]
        : [{ key: "chat", label: "Chat" }];
    default:
      return [{ key: tab.kind, label: tab.title }];
  }
}

export function breadcrumbsForTab(tab: Tab | undefined, conversationTitle?: string): string[] {
  return breadcrumbItemsForTab(tab, conversationTitle).map((breadcrumb) => breadcrumb.label);
}

function HeaderButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="no-drag relative -mx-1 inline-flex h-7 w-6 items-center justify-center rounded-sm text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-35"
      onClick={onClick}
    >
      <span
        data-header-icon
        className="flex items-center justify-center [&>svg]:size-3.5"
        style={{ width: "14px", height: "14px" }}
      >
        {children}
      </span>
    </button>
  );
}

export default function NavigationHeader() {
  const tabs = useTabs((state) => state.tabs);
  const activeTabId = useTabs((state) => state.activeTabId);
  const canGoBack = useTabs((state) => state.canGoBack);
  const canGoForward = useTabs((state) => state.canGoForward);
  const goBack = useTabs((state) => state.goBack);
  const goForward = useTabs((state) => state.goForward);
  const closeTab = useTabs((state) => state.closeTab);
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const requestHomeRefresh = useUi((state) => state.requestHomeRefresh);
  const requestTerminalOverview = useTabs((state) => state.requestTerminalOverview);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeThreadId = useThreads((state) => state.activeThreadId);
  const activeThreadTitle = useThreads((state) =>
    state.threads.find((thread) => thread.id === activeThreadId)?.title,
  );
  const hermesSessionId = useHermesChat((state) => state.sessionId);
  const hermesConversations = useHermesChat((state) => state.conversations);
  const hermesConversationTitle = hermesSessionId
    ? hermesConversations.find((conversation) => conversation.id === hermesSessionId)?.title
    : undefined;
  const activeConversationTitle = activeThreadTitle ?? hermesConversationTitle;
  const breadcrumbs = breadcrumbItemsForTab(activeTab, activeConversationTitle);
  const hasContextActions = Boolean(
    activeTab && activeTab.kind !== "terminals" && activeTab.kind !== "terminal",
  );

  return (
    <header
      className="titlebar-drag absolute inset-x-0 top-0 grid shrink-0 items-center"
      style={{
        zIndex: DESKTOP_Z_INDEX.chrome,
        height: "var(--titlebar-height)",
        gridTemplateColumns: "var(--sidebar-expanded-width) minmax(0, 1fr)",
        background: "var(--bg-sunken)",
      }}
    >
      <div
        className="flex items-center justify-end px-4"
        data-testid="sidebar-navigation-actions"
        style={{ gap: "8px" }}
      >
        <HeaderButton label="Go back" disabled={!canGoBack} onClick={goBack}>
          <ChevronLeft size={14} />
        </HeaderButton>
        <HeaderButton label="Go forward" disabled={!canGoForward} onClick={goForward}>
          <ChevronRight size={14} />
        </HeaderButton>
        <HeaderButton
          label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleSidebar}
        >
          <PanelLeft size={14} />
        </HeaderButton>
      </div>

      <div className="flex min-w-0 items-center gap-1 px-2">
        <nav aria-label="Breadcrumb" className="no-drag flex min-w-0 items-center gap-1 text-[13px]">
          {breadcrumbs.map((breadcrumb, index) => (
            <Fragment key={breadcrumb.key}>
              {index > 0 ? (
                <ChevronRight size={12} className="shrink-0" style={{ color: "var(--text-disabled)" }} />
              ) : null}
              {activeTab?.kind === "terminals" && index === 0 && breadcrumbs.length > 1 ? (
                <button
                  type="button"
                  className="max-w-[220px] truncate rounded-sm px-0.5 hover:text-[var(--text-primary)]"
                  style={{ color: "var(--text-tertiary)", fontWeight: 400 }}
                  onClick={requestTerminalOverview}
                >
                  {breadcrumb.label}
                </button>
              ) : (
                <span
                  className="max-w-[220px] truncate"
                  style={{
                    color: index === breadcrumbs.length - 1
                      ? "var(--text-primary)"
                      : "var(--text-tertiary)",
                    fontWeight: index === breadcrumbs.length - 1 ? 500 : 400,
                  }}
                >
                  {breadcrumb.label}
                </span>
              )}
            </Fragment>
          ))}
          {breadcrumbs.length > 0 && hasContextActions ? (
            <ChevronRight
              size={12}
              className="shrink-0"
              style={{ color: "var(--text-disabled)" }}
              aria-hidden="true"
            />
          ) : null}
        </nav>

        {activeTab && hasContextActions ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              aria-label={`Actions for ${activeTab.title}`}
              title={`Actions for ${activeTab.title}`}
              disabled={activeTab.kind !== "home" && !activeTab.closable}
              className="no-drag -mx-[5px] inline-flex h-7 w-6 items-center justify-center rounded-sm text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-35"
            >
              <MoreHorizontal size={14} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="z-[100] min-w-[160px] rounded-lg border p-1 shadow-lg"
                style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)" }}
              >
                {activeTab.kind === "home" ? (
                  <DropdownMenu.Item
                    className="cursor-default rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)]"
                    style={{ color: "var(--text-primary)" }}
                    onSelect={requestHomeRefresh}
                  >
                    Refresh Home
                  </DropdownMenu.Item>
                ) : null}
                {activeTab.closable ? (
                  <DropdownMenu.Item
                    className="cursor-default rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)]"
                    style={{ color: "var(--text-primary)" }}
                    onSelect={() => closeTab(activeTab.id)}
                  >
                    Close view
                  </DropdownMenu.Item>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
      </div>
    </header>
  );
}
