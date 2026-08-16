import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Fragment } from "react";
import { useHermesChat } from "../../stores/hermes-chat";
import { useTabs, type Tab } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";
import { useUi } from "../../stores/ui";

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
    case "project":
      return [
        { key: "projects", label: "Projects" },
        { key: `projects/${tab.projectSlug ?? tab.id}`, label: tab.title },
      ];
    case "task":
      return [
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
        { key: `terminal/${tab.sessionName ?? tab.id}`, label: tab.title },
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
      className="no-drag inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-35"
      style={{ color: "var(--text-tertiary)" }}
      onClick={onClick}
    >
      {children}
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

  return (
    <header
      className="titlebar-drag flex shrink-0 items-center gap-1 border-b px-2"
      style={{
        height: "var(--tabbar-height)",
        borderColor: "var(--border-subtle)",
        background: "var(--bg-sunken)",
      }}
    >
      <HeaderButton
        label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={toggleSidebar}
      >
        {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </HeaderButton>
      <HeaderButton label="Go back" disabled={!canGoBack} onClick={goBack}>
        <ChevronLeft size={16} />
      </HeaderButton>
      <HeaderButton label="Go forward" disabled={!canGoForward} onClick={goForward}>
        <ChevronRight size={16} />
      </HeaderButton>

      <nav aria-label="Breadcrumb" className="no-drag ml-1 flex min-w-0 items-center gap-1 text-sm">
        {breadcrumbs.map((breadcrumb, index) => (
          <Fragment key={breadcrumb.key}>
            {index > 0 ? (
              <ChevronRight size={12} className="shrink-0" style={{ color: "var(--text-disabled)" }} />
            ) : null}
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
          </Fragment>
        ))}
      </nav>

      {activeTab?.closable ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            aria-label={`Actions for ${activeTab.title}`}
            title={`Actions for ${activeTab.title}`}
            className="no-drag ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-tertiary)" }}
          >
            <MoreHorizontal size={15} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-[100] min-w-[160px] rounded-lg border p-1 shadow-lg"
              style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)" }}
            >
              <DropdownMenu.Item
                className="cursor-default rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)]"
                style={{ color: "var(--text-primary)" }}
                onSelect={() => closeTab(activeTab.id)}
              >
                Close view
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
    </header>
  );
}
