"use client";

import type { ChatMessage } from "@/lib/chat";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  WrenchIcon,
  CheckCircleIcon,
  LoaderCircleIcon,
  ChevronDownIcon,
} from "lucide-react";

function toolContext(msg: ChatMessage): string | undefined {
  const input = msg.toolInput;
  if (!input) return undefined;
  const tool = msg.tool;
  if (tool === "Read" || tool === "Edit" || tool === "Write") {
    return typeof input.file_path === "string" ? input.file_path : undefined;
  }
  if (tool === "Bash") {
    return typeof input.command === "string"
      ? input.command.length > 60 ? input.command.slice(0, 57) + "..." : input.command
      : undefined;
  }
  if (tool === "Grep") {
    return typeof input.pattern === "string" ? `/${input.pattern}/` : undefined;
  }
  if (tool === "Glob") {
    return typeof input.pattern === "string" ? input.pattern : undefined;
  }
  return undefined;
}

interface ToolCallGroupProps {
  tools: ChatMessage[];
}

export function ToolCallGroup({ tools }: ToolCallGroupProps) {
  const hasRunning = tools.some((t) => t.content.startsWith("Using "));
  const count = tools.length;
  const singleContext = count === 1 ? toolContext(tools[0]) : undefined;
  const label =
    count === 1
      ? tools[0].tool ?? "tool"
      : `${count} tools`;

  return (
    <Collapsible className="group not-prose w-full rounded-md border">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">{label}</span>
          {singleContext && (
            <span className="truncate text-xs text-muted-foreground font-mono">{singleContext}</span>
          )}
          {hasRunning ? (
            <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <CheckCircleIcon className="size-4 shrink-0 text-green-600" />
          )}
        </div>
        {count > 1 && (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        )}
      </CollapsibleTrigger>
      {count > 1 && (
        <CollapsibleContent className="border-t px-3 py-2 space-y-1">
          {tools.map((t) => {
            const isRunning = t.content.startsWith("Using ");
            const ctx = toolContext(t);
            return (
              <div key={t.id} className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground py-0.5">
                {isRunning ? (
                  <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
                ) : (
                  <CheckCircleIcon className="size-3 shrink-0 text-green-600" />
                )}
                <span className="shrink-0">{t.tool}</span>
                {ctx && <span className="truncate font-mono">{ctx}</span>}
              </div>
            );
          })}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
