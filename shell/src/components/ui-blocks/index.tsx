"use client";

import { createContext, useContext, type ComponentProps } from "react";
import { FileText } from "lucide-react";
import { resolveChatMessageLink } from "@matrix-os/contracts";
import { parseContentSegments, type UICardData, type UIOptionData } from "@/lib/ui-blocks";
import { MessageResponse } from "@/components/ai-elements/message";
import { CardGrid } from "./CardGrid";
import { OptionList } from "./OptionList";
import { StatusBanner } from "./StatusBanner";

interface RichContentProps {
  children: string;
  onAction?: (text: string) => void;
  openFile?: (path: string) => boolean | void;
}

type MarkdownPart =
  | { type: "markdown"; content: string }
  | { type: "local-image"; source: string; label: string };

function splitLocalMarkdownImages(content: string, enabled: boolean): MarkdownPart[] {
  if (!enabled || !content.includes("![")) return [{ type: "markdown", content }];
  const parts: MarkdownPart[] = [];
  let markdown = "";
  let fence: { marker: string; length: number } | null = null;
  const appendMarkdown = (value: string) => { markdown += value; };
  const flushMarkdown = () => {
    if (markdown) parts.push({ type: "markdown", content: markdown });
    markdown = "";
  };

  for (const line of content.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue;
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null;
      appendMarkdown(line);
      continue;
    }
    if (fence) {
      appendMarkdown(line);
      continue;
    }

    const tokenPattern = /`+[^`\n]*`+|!\[([^\]\n]{0,280})\]\(([^)\s\n]{1,4096})(?:\s+"[^"\n]*")?\)/g;
    let cursor = 0;
    for (const match of line.matchAll(tokenPattern)) {
      const index = match.index ?? 0;
      appendMarkdown(line.slice(cursor, index));
      const target = match[2] ? resolveChatMessageLink(match[2]) : null;
      if (target?.kind === "file") {
        flushMarkdown();
        parts.push({
          type: "local-image",
          source: match[2],
          label: match[1]?.trim() || target.path.split("/").at(-1) || "image",
        });
      } else {
        appendMarkdown(match[0]);
      }
      cursor = index + match[0].length;
    }
    appendMarkdown(line.slice(cursor));
  }
  flushMarkdown();
  return parts.length ? parts : [{ type: "markdown", content }];
}

const ChatFileOpenContext = createContext<RichContentProps["openFile"]>(undefined);
function ChatInlineCode({ children, className, node: _node, ...props }: ComponentProps<"code"> & { node?: unknown }) {
  const openFile=useContext(ChatFileOpenContext);
  const value=String(children);
  const target=/[\\/]/.test(value) ? resolveChatMessageLink(value) : null;
  if(openFile && target?.kind === "file") return <button type="button" aria-label={`Open ${target.path.split("/").at(-1)}`}
    title={value} onClick={()=>openFile(value)} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 align-middle font-mono text-xs hover:bg-accent">
    <FileText size={13} aria-hidden/><span className="truncate">{target.path.split("/").at(-1)}</span>
  </button>;
  return <code {...props} className={className ?? "rounded bg-muted px-1.5 py-0.5 font-mono text-sm"}>{children}</code>;
}
const chatMarkdownComponents={inlineCode:ChatInlineCode};

function MarkdownWithLocalImages({ content, openFile }: { content: string; openFile?: RichContentProps["openFile"] }) {
  const parts = splitLocalMarkdownImages(content, Boolean(openFile));
  return parts.map((part, index) => part.type === "markdown" ? (
    <ChatFileOpenContext.Provider key={`markdown:${index}`} value={openFile}><MessageResponse components={chatMarkdownComponents}>{part.content}</MessageResponse></ChatFileOpenContext.Provider>
  ) : (
    <button
      key={`image:${index}:${part.source}`}
      type="button"
      aria-label={`Preview image ${part.label}`}
      title={part.source}
      onClick={() => openFile?.(part.source)}
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs text-primary hover:bg-accent"
    >
      <span aria-hidden>▧</span>
      <span className="truncate">{part.label}</span>
    </button>
  ));
}

export function RichContent({ children, onAction, openFile }: RichContentProps) {
  const segments = parseContentSegments(children);

  if (segments.length === 1 && segments[0].type === "markdown") {
    return <MarkdownWithLocalImages content={children} openFile={openFile} />;
  }

  return (
    <>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case "markdown":
            // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key -- rich-content markdown segments are an ordered parse of one immutable message; duplicate markdown text has no stable id, so position is the collision-free identity.
            return <MarkdownWithLocalImages key={`md:${i}`} content={seg.content} openFile={openFile} />;
          case "ui:cards":
            return (
              <CardGrid
                // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key -- rich-content card groups are ordered segments within one immutable parsed message; duplicate card groups have no stable id, so segment position is the collision-free identity.
                key={`cards:${i}`}
                cards={seg.data}
                onSelect={(card: UICardData) =>
                  onAction?.(card.title)
                }
              />
            );
          case "ui:options":
            return (
              <OptionList
                // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key -- rich-content option groups are ordered segments within one immutable parsed message; duplicate option groups have no stable id, so segment position is the collision-free identity.
                key={`options:${i}`}
                options={seg.data}
                onSelect={(opt: UIOptionData) =>
                  onAction?.(opt.value ?? opt.label)
                }
              />
            );
          case "ui:status":
            return (
              <StatusBanner
                // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key -- rich-content status banners are ordered segments within one immutable parsed message; duplicate banners have no stable id, so segment position is the collision-free identity.
                key={`status:${i}`}
                status={seg.data}
              />
            );
        }
      })}
    </>
  );
}
