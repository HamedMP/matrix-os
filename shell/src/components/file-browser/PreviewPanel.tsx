"use client";

import { useState, useEffect } from "react";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { getGatewayUrl } from "@/lib/gateway";
import {
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  FileCodeIcon,
} from "lucide-react";

const GATEWAY_URL = getGatewayUrl();

interface FileStat {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified: string;
  created: string;
  mime?: string;
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PreviewPanel() {
  const showPreviewPanel = useFileBrowser((s) => s.showPreviewPanel);
  const selectedPaths = useFileBrowser((s) => s.selectedPaths);
  const currentPath = useFileBrowser((s) => s.currentPath);
  const [stat, setStat] = useState<FileStat | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const selectedName =
    selectedPaths.size === 1 ? Array.from(selectedPaths)[0] : null;
  const selectedFullPath = selectedName
    ? currentPath
      ? `${currentPath}/${selectedName}`
      : selectedName
    : null;

  useEffect(() => {
    if (!selectedFullPath || !showPreviewPanel) {
      setStat(null);
      setPreview(null);
      return;
    }

    fetch(
      `${GATEWAY_URL}/api/files/stat?path=${encodeURIComponent(selectedFullPath)}`,
    )
      .then((r) => r.json())
      .then((data: FileStat) => setStat(data))
      .catch(() => setStat(null));

    if (selectedName && isTextLike(selectedName)) {
      fetch(`${GATEWAY_URL}/files/${selectedFullPath}`)
        .then((r) => (r.ok ? r.text() : null))
        .then((text) => {
          if (text) {
            setPreview(text.split("\n").slice(0, 20).join("\n"));
          }
        })
        .catch(() => setPreview(null));
    } else {
      setPreview(null);
    }
  }, [selectedFullPath, showPreviewPanel, selectedName]);

  if (!showPreviewPanel) return null;

  if (!stat) {
    return (
      <div className="w-56 border-l border-border p-3 text-sm text-muted-foreground shrink-0">
        {selectedPaths.size === 0
          ? "No selection"
          : selectedPaths.size > 1
            ? `${selectedPaths.size} items selected`
            : "Loading..."}
      </div>
    );
  }

  const Icon =
    stat.type === "directory"
      ? FolderIcon
      : isImage(stat.name)
        ? ImageIcon
        : isCode(stat.name)
          ? FileCodeIcon
          : FileTextIcon;

  return (
    <div className="w-56 border-l border-border overflow-y-auto p-3 text-sm shrink-0">
      <div className="flex flex-col items-center gap-2 mb-4">
        {isImage(stat.name) && stat.type === "file" ? (
          <img
            src={`${GATEWAY_URL}/files/${stat.path}`}
            alt={stat.name}
            className="max-w-full max-h-32 rounded object-contain"
          />
        ) : (
          <Icon className="size-12 text-muted-foreground" />
        )}
        <div className="font-medium text-center break-all">{stat.name}</div>
      </div>

      <dl className="space-y-2 text-xs">
        <InfoRow label="Type" value={stat.type === "directory" ? "Folder" : stat.mime ?? "File"} />
        {stat.size !== undefined && (
          <InfoRow label="Size" value={formatBytes(stat.size)} />
        )}
        <InfoRow label="Modified" value={new Date(stat.modified).toLocaleString()} />
        <InfoRow label="Created" value={new Date(stat.created).toLocaleString()} />
        <InfoRow label="Path" value={stat.path} />
      </dl>

      {preview && (
        <div className="mt-3">
          <div className="text-xs font-medium text-muted-foreground mb-1">Preview</div>
          <pre className="text-xs bg-muted/50 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap break-all">
            {preview}
          </pre>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all">{value}</dd>
    </div>
  );
}

function isImage(name: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(name);
}

function isCode(name: string): boolean {
  return /\.(js|ts|jsx|tsx|py|html|css|sh|json|yaml|yml|toml)$/i.test(name);
}

function isTextLike(name: string): boolean {
  return /\.(md|txt|log|csv|json|yaml|yml|toml|js|ts|jsx|tsx|py|html|css|sh|xml|ini|cfg|conf|env|gitignore|editorconfig)$/i.test(name);
}
