"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { GripHorizontal, Plus, X } from "lucide-react";
import {
  ChatInspectorNewTab,
  ChatInspectorResizeHandle,
  ChatInspectorTabs,
  InspectorToolIcon,
  SideChatPanel,
} from "@matrix-os/ui";
import { useTheme } from "@/hooks/useTheme";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { ChatFilePanel } from "./ChatFilePanel";
import { WebChatFileTree } from "./WebChatFileTree";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWebChatInspector, type WebChatInspectorProps } from "./useWebChatInspector";
import { toGatewayProjectFileResource } from "./web-projects";
import { NEW } from "./web-chat-inspector-state";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

export function WebChatInspector(props: WebChatInspectorProps) {
  return <InspectorContent key={JSON.stringify([props.layoutKey, props.gatewayUrl, props.chatId])} {...props} />;
}
function InspectorContent({
  active = true,
  chatId,
  chatTitle,
  gatewayUrl,
  layoutKey,
  rootWidth,
  railWidth,
  project,
  worktreeId,
  projectLoading,
  projectError,
  onRetryProject,
  filePath,
  fileOpenRequest,
  fileResource,
  onFilePathChange,
  terminalSessionIds,
  sideChatClient,
  onSendToMain,
  onClose,
}: WebChatInspectorProps) {
  const theme = useTheme();
  const previewResource = toGatewayProjectFileResource(fileResource, project);
  const previewBlocked = previewResource?.kind !== "home" && (projectLoading || projectError);
  const {
    layout,
    setLayout,
    sessions,
    registryReady,
    pending,
    error,
    closeTarget,
    setCloseTarget,
    fileExpanded,
    setFileExpanded,
    menuOpen,
    setMenuOpen,
    panelRef,
    treeHeight,
    treeMin,
    treeMax,
    selected,
    overlay,
    maxWidth,
    width,
    closeTab,
    picker,
    choose,
    openTab,
    createTerminal,
    stopTerminal,
    drag,
  } = useWebChatInspector({
    active,
    chatId,
    chatTitle,
    gatewayUrl,
    layoutKey,
    rootWidth,
    railWidth,
    project,
    projectLoading,
    projectError,
    filePath,
    fileOpenRequest,
    onFilePathChange,
    terminalSessionIds,
    sideChatClient,
    onSendToMain,
    onClose,
  });
  return (
    <>
      <aside
        ref={panelRef}
        aria-label="Chat inspector"
        className={`${overlay ? "absolute inset-y-0 right-0 z-30" : "relative shrink-0"} ph-no-capture desktop-chat-design flex min-h-0 flex-col border-l bg-background`}
        style={{
          width: overlay ? Math.max(240, rootWidth - railWidth) : width,
        }}
      >
        {!overlay ? (
          <ChatInspectorResizeHandle
            side="left"
            label="Resize Chat inspector"
            value={width}
            min={240}
            max={maxWidth}
            onPointerDown={(event) => drag(event, "width")}
            onReset={() => setLayout((current) => ({ ...current, width: 400 }))}
            onKeyboardResize={(delta) =>
              setLayout((current) => ({
                ...current,
                width: Math.max(240, Math.min(maxWidth, current.width + delta)),
              }))
            }
          />
        ) : null}
        <ChatInspectorTabs
          tabs={layout.tabs}
          selectedId={selected.id}
          onSelect={(id) => setLayout((current) => ({ ...current, selected: id }))}
          onClose={closeTab}
          onAdd={picker}
          addControl={
            <DropdownMenu.Root
              open={menuOpen}
              onOpenChange={(open) => {
                if (open && layout.tabs.length === 1 && selected.kind === "files" && !filePath) picker();
                else setMenuOpen(open);
              }}
            >
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="desktop-chat-icon mb-1 shrink-0"
                  aria-label="Add inspector tab"
                  onClick={() => {
                    if (layout.tabs.length === 1 && selected.kind === "files" && !filePath) picker();
                  }}
                >
                  <Plus size={16} aria-hidden />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="desktop-chat-design min-w-52 rounded-lg border p-1 shadow-lg"
                  style={{ zIndex: SHELL_Z_INDEX.appDialog }}
                >
                  <DropdownMenu.Item
                    onSelect={picker}
                    className="flex cursor-default items-center gap-2 rounded px-2.5 py-1.5 outline-none data-[highlighted]:bg-accent"
                  >
                    <Plus size={14} />
                    New tab
                  </DropdownMenu.Item>
                  {(["files", "terminal", "side-chat"] as const).map((kind) => (
                    <DropdownMenu.Item
                      key={kind}
                      onSelect={() => choose(kind)}
                      className="flex cursor-default items-center gap-2 rounded px-2.5 py-1.5 outline-none data-[highlighted]:bg-accent"
                    >
                      <InspectorToolIcon kind={kind} />
                      <span className="flex-1">
                        {kind === "files" ? "Files" : kind === "terminal" ? "Terminal" : "Side chat"}
                      </span>
                      <kbd className="text-xs text-muted-foreground">
                        {kind === "files" ? "⌘P" : kind === "terminal" ? "⌃`" : "⌥⌘S"}
                      </kbd>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          }
          trailing={
            overlay ? (
              <button
                type="button"
                className="desktop-chat-icon mb-1 ml-auto"
                aria-label="Close inspector"
                onClick={onClose}
              >
                <X size={14} />
              </button>
            ) : null
          }
        />
        {selected.kind === "new" ? (
          <ChatInspectorNewTab
            onChoose={choose}
            recent={[
              ...(filePath ? [{ id: "recent-file", kind: "files" as const, title: filePath.split("/").pop() ?? filePath, subtitle: filePath, onOpen: () => choose("files") }] : []),
              ...sessions.map((session) => ({
              id: session.ref,
              kind: "terminal" as const,
              title: session.name,
              subtitle: session.cwd,
              onOpen: () =>
                openTab({
                  id: `terminal:${session.ref}`,
                  kind: "terminal",
                  label: session.name,
                }),
            })),
              ...(layout.tabs.some(tab => tab.kind === "side-chat") ? [{ id: "recent-side", kind: "side-chat" as const, title: "Side chat", subtitle: "Saved conversation", onOpen: () => choose("side-chat") }] : []),
            ]}
          />
        ) : null}
        {selected.kind === "files" ? (
          <div
            role="tabpanel"
            aria-label="Files"
            id="work-inspector-panel-files"
            className="flex min-h-0 flex-1 flex-col"
          >
            {!fileExpanded || !filePath ? (
              <div
                className="flex min-h-0 shrink-0 flex-col overflow-hidden"
                style={{
                  height: filePath ? treeHeight : undefined,
                  flex: filePath ? undefined : 1,
                }}
              >
                {projectLoading ? <p role="status" className="p-3 text-sm text-muted-foreground">Loading project files…</p> : projectError ? <div className="p-3 text-sm"><p role="alert">Project files are unavailable.</p><Button variant="outline" size="sm" className="mt-2" onClick={onRetryProject}>Retry project files</Button></div> : <WebChatFileTree
                  key={JSON.stringify([gatewayUrl, project?.id, project?.slug, worktreeId])}
                  gatewayUrl={gatewayUrl}
                  project={project}
                  worktreeId={worktreeId}
                  selectedPath={filePath ?? undefined}
                  revealKey={fileOpenRequest}
                  onOpenFile={onFilePathChange}
                />}
              </div>
            ) : null}
            {filePath && !previewBlocked ? (
              <>
                {!fileExpanded ? (
                  <div
                    role="separator"
                    aria-label="Resize file list"
                    aria-orientation="horizontal"
                    aria-valuemin={treeMin}
                    aria-valuemax={treeMax}
                    aria-valuenow={Math.round(treeHeight)}
                    tabIndex={0}
                    className="relative h-2 shrink-0 cursor-row-resize"
                    onPointerDown={(event) => drag(event, "tree")}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault();
                        setLayout((current) => ({
                          ...current,
                          treeHeight: Math.max(
                            treeMin,
                            Math.min(
                              treeMax,
                              treeHeight + (event.key === "ArrowDown" ? 16 : -16),
                            ),
                          ),
                        }));
                      }
                    }}
                  >
                    <span className="absolute inset-x-0 top-[3px] h-px bg-border" />
                    <GripHorizontal size={12} aria-hidden className="absolute left-1/2 top-[-2px] -translate-x-1/2" />
                  </div>
                ) : null}
                <ChatFilePanel
                  path={filePath}
                  resource={previewResource}
                  gatewayUrl={gatewayUrl}
                  embedded
                  onExpand={() => setFileExpanded((value) => !value)}
                  onClose={() => {
                    setFileExpanded(false);
                    onFilePathChange(null);
                  }}
                />
              </>
            ) : null}
          </div>
        ) : null}
        {layout.tabs.some(tab => tab.kind === "side-chat") ? (
          <div
            role="tabpanel"
            aria-label="Side chat"
            hidden={selected.kind !== "side-chat"}
            id="work-inspector-panel-side-chat"
            className={selected.kind === "side-chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
          >
            <SideChatPanel chatId={chatId} chatTitle={chatTitle} client={sideChatClient} onSendToMain={onSendToMain} />
          </div>
        ) : null}
        {layout.tabs
          .filter((tab) => tab.kind === "terminal")
          .map((tab) => {
            const session = sessions.find((item) => `terminal:${item.ref}` === tab.id);
            return (
              <div
                key={tab.id}
                role="tabpanel"
                aria-label={tab.label}
                id={`work-inspector-panel-${tab.id}`}
                hidden={selected.id !== tab.id}
                className={selected.id === tab.id ? "relative flex min-h-0 flex-1 flex-col" : "hidden"}
              >
                <header className="chat-inspector-terminal-header">
                  <span aria-label="Terminal working directory">{session?.cwd || "~"}</span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      void createTerminal();
                    }}
                  >
                    <Plus size={14} aria-hidden />
                    New terminal
                  </button>
                </header>
                {session?.attachable ? (
                  <TerminalPane
                    paneId={`chat-${chatId}-${tab.id}`}
                    cwd={session.cwd}
                    theme={theme}
                    isFocused={active && selected.id === tab.id}
                    sessionId={session.ref}
                    chatId={chatId}
                    shouldCacheOnUnmount={() => false}
                  />
                ) : (
                  <p className="p-3 text-sm text-muted-foreground">
                    {registryReady ? "This terminal is unavailable." : "Loading terminal…"}
                  </p>
                )}
              </div>
            );
          })}
        {error && !closeTarget ? (
          <p role="alert" className="p-3 text-xs text-destructive">
            The terminal could not be updated. Try again.
          </p>
        ) : null}
      </aside>
      <Dialog
        open={Boolean(closeTarget)}
        onOpenChange={(open) => {
          if (!open && !pending) setCloseTarget(null);
        }}
      >
        <DialogContent
          role="alertdialog"
          aria-label="Stop this terminal?"
          showCloseButton={false}
          className="sm:max-w-[400px]"
          style={{ zIndex: SHELL_Z_INDEX.appDialog }}
          overlayStyle={{ zIndex: SHELL_Z_INDEX.appDialog }}
        >
          <DialogHeader>
            <DialogTitle>Stop this terminal?</DialogTitle>
            <DialogDescription>Closing this tab stops its terminal session.</DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              The terminal could not be stopped. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setCloseTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => {
                void stopTerminal();
              }}
            >
              Stop terminal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
