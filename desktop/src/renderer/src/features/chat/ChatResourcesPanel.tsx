import { FileText, Link2, Plug, Upload, X } from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useRef } from "react";
import type { ChatMessage } from "../../lib/chat";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { useIntegrations } from "../integrations/integrations-store";

const RESOURCE_CAP = 50;
const ATTACHMENT_HEADING = "Attached files (available on your Matrix computer):\n";
const ATTACHMENT_LINE = /^- ~\/temporary\/desktop-chat\/(.+) \(\/home\/matrix\/home\/temporary\/desktop-chat\/(.+)\)$/;

function readableAttachmentName(storedName: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(storedName);
    } catch (error: unknown) {
      console.warn(
        "[chat-resources] attachment name decode failed:",
        error instanceof URIError ? error.name : "Unknown error",
      );
      return storedName;
    }
  })();
  const basename = decoded.split(/[\\/]/).at(-1) ?? "";
  return basename.replace(/^[A-Za-z0-9]+-/, "").slice(0, 180) || "Attachment";
}

export function sharedConversationResources(messages: ChatMessage[]): string[] {
  const resources: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const name of conversationMessageDisplay(message.content).attachments) {
      if (!seen.has(name)) {
        seen.add(name);
        resources.push(name);
      }
      if (resources.length >= RESOURCE_CAP) return resources;
    }
  }
  return resources;
}

export function conversationMessageDisplay(content: string): {
  text: string;
  attachments: string[];
} {
  const headingIndex = content.lastIndexOf(ATTACHMENT_HEADING);
  if (headingIndex < 0 || (headingIndex > 1 && content.slice(headingIndex - 2, headingIndex) !== "\n\n")) {
    return { text: content, attachments: [] };
  }
  const attachments: string[] = [];
  const seen = new Set<string>();
  for (const line of content.slice(headingIndex + ATTACHMENT_HEADING.length).split("\n")) {
    const match = ATTACHMENT_LINE.exec(line);
    if (!match || match[1] !== match[2]) continue;
    const storedName = match[1];
    if (!storedName) continue;
    const name = readableAttachmentName(storedName);
    if (seen.has(name)) continue;
    seen.add(name);
    attachments.push(name);
    if (attachments.length >= RESOURCE_CAP) break;
  }
  if (attachments.length === 0) return { text: content, attachments: [] };
  return {
    text: content.slice(0, headingIndex).trim(),
    attachments,
  };
}

function connectedToolsCopy(status: ReturnType<typeof useIntegrations.getState>["status"]): string {
  if (status === "loading" || status === "idle") return "Loading connected tools…";
  if (status === "unavailable") return "Connected tools are not available from this Gateway.";
  if (status === "error") return "Connected tools could not be loaded. Try again from Integrations.";
  return "No connected tools.";
}

export function ChatResourcesPanel({
  messages,
  onClose,
  onUpload,
}: {
  messages: ChatMessage[];
  onClose: (restoreFocus?: boolean) => void;
  onUpload: () => void;
}) {
  const api = useConnection((state) => state.api);
  const connections = useIntegrations((state) => state.connections);
  const integrationsStatus = useIntegrations((state) => state.status);
  const refreshIntegrations = useIntegrations((state) => state.refresh);
  const requestSettingsSection = useUi((state) => state.requestSettingsSection);
  const openTab = useTabs((state) => state.openTab);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const sharedResources = useMemo(() => sharedConversationResources(messages), [messages]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (api && integrationsStatus === "idle") void refreshIntegrations(api);
  }, [api, integrationsStatus, refreshIntegrations]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const openIntegrations = () => {
    requestSettingsSection("integrations");
    openTab({ kind: "settings", title: "Settings" });
    onClose(false);
  };

  return (
    <div className="absolute inset-0 z-20 flex justify-end">
      <button
        type="button"
        aria-label="Dismiss Resources"
        className="absolute inset-0 cursor-default bg-black/10"
        onClick={() => onClose()}
      />
      <aside
        aria-label="Resources"
        className="relative flex h-full w-[min(380px,calc(100%-24px))] flex-col border-l shadow-[var(--shadow-3)]"
        style={{ background: "var(--bg-overlay)", borderColor: "var(--border-subtle)" }}
      >
        <header className="flex h-[78px] shrink-0 items-center justify-between border-b px-5" style={{ borderColor: "var(--border-subtle)" }}>
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Resources</h2>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close Resources"
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            style={{ color: "var(--text-secondary)" }}
            onClick={() => onClose()}
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <ResourceSection title="Shared with agent">
            {sharedResources.length > 0 ? sharedResources.map((name) => (
              <div key={name} className="flex h-[52px] items-center gap-3 border-b last:border-b-0" style={{ borderColor: "var(--border-subtle)" }}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--bg-sunken)", color: "var(--text-secondary)" }}>
                  <FileText size={15} aria-hidden />
                </span>
                <span className="min-w-0 truncate text-sm" style={{ color: "var(--text-primary)" }}>{name}</span>
              </div>
            )) : (
              <EmptyResourceCopy>No files have been shared in this chat.</EmptyResourceCopy>
            )}
          </ResourceSection>

          <ResourceSection title="Created by agent">
            <EmptyResourceCopy>Agent-created resources are not available from this Gateway yet.</EmptyResourceCopy>
          </ResourceSection>

          <ResourceSection title="Connected tools">
            {connections.length > 0 ? connections.map((connection) => (
              <div key={connection.id} className="flex min-h-10 items-center gap-3 border-b py-2 last:border-b-0" style={{ borderColor: "var(--border-subtle)" }}>
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--bg-sunken)", color: "var(--text-secondary)" }}>
                  <Link2 size={14} aria-hidden />
                </span>
                <span className="min-w-0 truncate text-sm" style={{ color: "var(--text-primary)" }}>{connection.accountLabel}</span>
              </div>
            )) : (
              <EmptyResourceCopy>
                {connectedToolsCopy(integrationsStatus)}
              </EmptyResourceCopy>
            )}
          </ResourceSection>
        </div>

        <footer className="grid shrink-0 grid-cols-2 gap-2 border-t p-4" style={{ borderColor: "var(--border-subtle)" }}>
          <button
            type="button"
            className="flex h-9 items-center justify-center gap-2 rounded-lg border text-sm font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
            onClick={onUpload}
          >
            <Upload size={14} aria-hidden />
            Upload file
          </button>
          <button
            type="button"
            className="flex h-9 items-center justify-center gap-2 rounded-lg border text-sm font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
            onClick={openIntegrations}
          >
            <Plug size={14} aria-hidden />
            Connect tool
          </button>
        </footer>
      </aside>
    </div>
  );
}

function ResourceSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7 last:mb-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--text-tertiary)" }}>{title}</h3>
      {children}
    </section>
  );
}

function EmptyResourceCopy({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border px-3 py-3 text-sm leading-5" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>{children}</p>;
}
