import { Copy, Download, Ellipsis, FolderOpen, PencilLine, Trash2, X } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, DropdownMenu, Icon, IconButton, LineTabs, TabPanel, type MenuEntry } from "../../../design/ds";
import { useConnection } from "../../../stores/connection";
import type { BrowserEntry } from "../browser-entries";
import { FilePreview } from "../FilePreviewPane";
import { formatModified } from "../format";
import { DesktopResourceSharing } from "../DesktopResourceSharing";
import { entryMeta, kindLabel, type FolderAccess } from "./file-presentation";
import { FileTile } from "./FileTile";

interface StatResult {
  created?: string;
  modified?: string;
}

const ACCESS_TEXT: Record<FolderAccess, string> = { own: "Only you", shared: "Shared", managed: "Managed by Matrix OS (read-only)" };

function useEntryStat(path: string): StatResult | null {
  const api = useConnection((state) => state.api);
  const [stat, setStat] = useState<{ path: string; value: StatResult } | null>(null);
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    api.get<StatResult>(`/api/files/stat?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setStat({ path, value }); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.warn("[files] Details unavailable:", error instanceof Error ? error.name : typeof error);
      });
    return () => controller.abort();
  }, [api, path]);
  return stat?.path === path ? stat.value : null;
}

function DetailRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-3 py-1.5">
      <dt className="text-ds-ui-sm text-ds-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-ds-ui-sm text-ds-foreground">{children}</dd>
    </div>
  );
}

/**
 * Right-hand details for one selected entry (⌘I): a header, Preview and
 * Details tabs, and the actions that work today. Activity, tags, star and
 * Ask Matrix stay out until their backend or chat handoff exists.
 */
export function DetailsPanel({
  entry,
  path,
  access,
  onClose,
  onOpen,
  onOpenInNewTab,
  onOpenInEditor,
  onDownload,
  downloadPending,
  onTrash,
}: {
  entry: BrowserEntry;
  path: string;
  access: FolderAccess;
  onClose: () => void;
  onOpen: () => void;
  onOpenInNewTab?: () => void;
  onOpenInEditor?: () => void;
  onDownload?: () => void;
  downloadPending?: boolean;
  onTrash?: () => void;
}) {
  const [tab, setTab] = useState(entry.type === "file" ? "preview" : "details");
  const stat = useEntryStat(path);
  const isFile = entry.type === "file";
  const moreEntries: MenuEntry[] = [
    ...(!isFile && onOpenInNewTab ? [{ kind: "item" as const, id: "open-tab", label: "Open in new tab", icon: <FolderOpen />, onSelect: onOpenInNewTab }] : []),
    ...(onDownload ? [{ kind: "item" as const, id: "download", label: "Download", icon: <Download />, disabled: downloadPending, onSelect: onDownload }] : []),
    { kind: "item", id: "copy-path", label: "Copy path", shortcut: "⌥⌘C", icon: <Copy />, onSelect: () => void copyPath(path) },
    ...(onTrash ? [
      { kind: "separator" as const, id: "trash-separator" },
      { kind: "item" as const, id: "trash", label: "Move to Trash", shortcut: "⌘⌫", icon: <Trash2 />, destructive: true, onSelect: onTrash },
    ] : []),
  ];
  return (
    <aside aria-label={`Details for ${entry.name}`} className="flex h-full min-h-0 w-[360px] shrink-0 flex-col border-l border-ds-tint-neutral-border bg-ds-background font-ds-sans">
      <div className="flex items-start gap-3 px-5 pt-5">
        <FileTile entry={entry} access={access} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-ds-ui-lg font-semibold text-ds-foreground" title={entry.name}>{entry.name}</h3>
          <p className="truncate text-ds-ui-sm text-ds-muted-foreground">{isFile ? entryMeta(entry) : `Folder · ${entryMeta(entry)}`}</p>
        </div>
        <IconButton label="Close details" shortcut="⌘I" size="xs" onClick={onClose}><Icon icon={X} size="sm" /></IconButton>
      </div>
      <div className="flex items-center gap-2 px-5 pt-4">
        {isFile && onOpenInEditor ? (
          <Button variant="primary" size="sm" onClick={onOpenInEditor}><Icon icon={PencilLine} size="sm" />Open in editor</Button>
        ) : (
          <Button variant="primary" size="sm" onClick={onOpen}><Icon icon={FolderOpen} size="sm" />Open</Button>
        )}
        <DesktopResourceSharing kind={isFile ? "file" : "folder"} path={path} />
        <DropdownMenu entries={moreEntries} trigger={<Button variant="ghost" size="sm" square aria-label="More actions"><Icon icon={Ellipsis} size="sm" /></Button>} />
      </div>
      <div className="px-5 pt-4">
        <LineTabs
          label="File details"
          idPrefix="files-details"
          tabs={isFile ? [{ id: "preview", label: "Preview" }, { id: "details", label: "Details" }] : [{ id: "details", label: "Details" }]}
          value={isFile ? tab : "details"}
          onChange={setTab}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {isFile ? (
          <TabPanel idPrefix="files-details" id="preview" active={tab === "preview"} className="flex h-full min-h-[240px] flex-col overflow-hidden rounded-lg border border-ds-tint-neutral-border bg-ds-card">
            <Suspense fallback={<p className="p-4 text-ds-ui-sm text-ds-muted-foreground">Loading preview…</p>}>
              <FilePreview path={path} entry={entry} />
            </Suspense>
          </TabPanel>
        ) : null}
        <TabPanel idPrefix="files-details" id="details" active={!isFile || tab === "details"}>
          <dl>
            <DetailRow term="Where">
              <span className="flex min-w-0 items-center gap-1">
                <code className="truncate font-ds-mono text-ds-ui-xs" title={path}>~/{path}</code>
                <IconButton label="Copy path" size="xs" tooltip={false} className="size-6" onClick={() => void copyPath(path)}><Icon icon={Copy} size="xs" /></IconButton>
              </span>
            </DetailRow>
            <DetailRow term="Kind">{kindLabel(entry)}</DetailRow>
            <DetailRow term="Modified">{formatModified(stat?.modified ?? entry.modifiedAt)}</DetailRow>
            <DetailRow term="Created">{formatModified(stat?.created)}</DetailRow>
            <DetailRow term="Access">{ACCESS_TEXT[access]}</DetailRow>
          </dl>
        </TabPanel>
      </div>
    </aside>
  );
}

async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(`~/${path}`);
    toast.success("Path copied");
  } catch (error: unknown) {
    console.warn("[files] Copy path failed:", error instanceof Error ? error.name : typeof error);
    toast.error("Couldn't copy the path.");
  }
}
