import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import {
  AppWindow,
  Braces,
  Folder,
  FolderKanban,
  ListTodo,
  SquareTerminal,
} from "@renderer/lib/hugeicons";
import { FileGlyph, kindForEntry } from "../files/file-kind";

type ComposerFileIconToken =
  | "typescript"
  | "javascript"
  | "json"
  | "markdown"
  | "python"
  | "rust"
  | "go"
  | "shell"
  | "yaml"
  | "html"
  | "css"
  | "generic";

function fileIconToken(path: string): ComposerFileIconToken {
  const name = path.split(/[\\/]/).at(-1)?.toLocaleLowerCase() ?? "";
  if (name.endsWith(".d.ts") || /\.(?:ts|tsx)$/.test(name)) return "typescript";
  if (/\.(?:js|jsx|mjs|cjs)$/.test(name)) return "javascript";
  if (/\.(?:json|jsonc|jsonl)$/.test(name)) return "json";
  if (/\.(?:md|mdx)$/.test(name)) return "markdown";
  if (/\.py$/.test(name)) return "python";
  if (/\.rs$/.test(name)) return "rust";
  if (/\.go$/.test(name)) return "go";
  if (/\.(?:sh|bash|zsh|fish)$/.test(name)) return "shell";
  if (/\.(?:yaml|yml)$/.test(name)) return "yaml";
  if (/\.(?:html|htm)$/.test(name)) return "html";
  if (/\.(?:css|scss|sass|less)$/.test(name)) return "css";
  return "generic";
}

const FILE_TOKEN_LABEL: Record<Exclude<ComposerFileIconToken, "json" | "generic">, string> = {
  typescript: "TS",
  javascript: "JS",
  markdown: "MD",
  python: "PY",
  rust: "RS",
  go: "GO",
  shell: "$_",
  yaml: "Y",
  html: "<>",
  css: "#",
};

const FILE_TOKEN_COLOR: Record<Exclude<ComposerFileIconToken, "generic">, string> = {
  typescript: "#3178c6",
  javascript: "#b89b00",
  json: "#d97706",
  markdown: "#6b7280",
  python: "#3776ab",
  rust: "#b45309",
  go: "#0891b2",
  shell: "#15803d",
  yaml: "#dc2626",
  html: "#e34f26",
  css: "#2563eb",
};

function ComposerFileTypeGlyph({ path, size, fallbackKind }: { path: string; size: number; fallbackKind: Parameters<typeof FileGlyph>[0]["kind"] }) {
  const token = fileIconToken(path);
  if (token === "generic") return <FileGlyph kind={fallbackKind} size={size} />;
  const color = FILE_TOKEN_COLOR[token];
  return (
    <span
      aria-hidden
      data-file-icon-token={token}
      {...(token === "json" ? {} : { "data-icon-label": FILE_TOKEN_LABEL[token] })}
      className="inline-flex shrink-0 items-center justify-center rounded-[4px] font-mono font-bold leading-none after:content-[attr(data-icon-label)]"
      style={{
        width: size,
        height: size,
        minWidth: size,
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        fontSize: Math.max(7, Math.round(size * 0.46)),
        letterSpacing: "-0.04em",
      }}
    >
      {token === "json" ? <Braces size={Math.max(10, size - 3)} strokeWidth={2.2} /> : null}
    </span>
  );
}

export function ComposerResourceGlyph({
  resource,
  size = 14,
}: {
  resource: CanonicalChatResourceReference;
  size?: number;
}) {
  if (resource.kind === "file") {
    const kind = kindForEntry({ name: resource.label, type: "file" });
    return (
      <span data-file-kind={kind} className="inline-flex">
        <ComposerFileTypeGlyph path={resource.label} size={size} fallbackKind={kind} />
      </span>
    );
  }
  if (resource.kind === "folder") {
    return <span data-file-kind="folder" className="inline-flex"><Folder size={size} aria-hidden /></span>;
  }
  if (resource.kind === "project") return <FolderKanban size={size} aria-hidden />;
  if (resource.kind === "task") return <ListTodo size={size} aria-hidden />;
  if (resource.kind === "app") return <AppWindow size={size} aria-hidden />;
  return <SquareTerminal size={size} aria-hidden />;
}
