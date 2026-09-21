"use client";

import { ConversationSubagentActivity } from "@matrix-os/ui";
import type { ChatMessage } from "@/lib/chat";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  WrenchIcon,
  XIcon,
  MinusIcon,
  CheckCircleIcon,
  LoaderCircleIcon,
  ChevronDownIcon,
} from "@/lib/hugeicons";

function toolContext(msg: ChatMessage): string | undefined {
  if (msg.toolDisplay?.preview) return msg.toolDisplay.preview;
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

function ToolStatus({ tool }: { tool: ChatMessage }) {
  const state = tool.toolDisplay?.state ?? (tool.content.startsWith("Using ") ? "running" : "completed");
  if (state === "running") return <LoaderCircleIcon aria-label="Running" className="size-4 shrink-0 animate-spin" />;
  if (state === "failed") return <XIcon aria-label="Failed" className="size-4 shrink-0 text-destructive" />;
  if (state === "stopped" || state === "partial") return <MinusIcon aria-label={state === "stopped" ? "Cancelled" : "Partial"} className="size-4 shrink-0" />;
  return <CheckCircleIcon aria-label="Completed" className="size-4 shrink-0 text-green-600" />;
}

export function ToolCallGroup({ tools }: ToolCallGroupProps) {
  if (!tools.some((tool) => tool.toolDisplay?.subagent)) return <OrdinaryToolCallGroup tools={tools} />;
  const sections: ChatMessage[][] = [];
  for (const tool of tools) {
    const previous = sections.at(-1);
    if (tool.toolDisplay?.subagent || !previous || previous[0]?.toolDisplay?.subagent) sections.push([tool]);
    else previous.push(tool);
  }
  return <div className="flex min-w-0 flex-col gap-1.5">
    {sections.map((section) => section[0].toolDisplay?.subagent
      ? <ConversationSubagentActivity key={section[0].id} agent={section[0].toolDisplay.subagent} />
      : <OrdinaryToolCallGroup key={section[0].id} tools={section} />)}
  </div>;
}

function OrdinaryToolCallGroup({ tools }: ToolCallGroupProps) {
  const statusTool = tools.find((tool) => tool.toolDisplay?.state === "running" || (!tool.toolDisplay && tool.content.startsWith("Using ")))
    ?? tools.find((tool) => tool.toolDisplay?.state === "failed") ?? tools[0];
  if (!statusTool) return null;
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
          <ToolStatus tool={statusTool} />
        </div>
        {(count > 1 || tools.some((tool) => tool.toolDisplay?.detail || tool.toolDisplay?.preview)) && (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        )}
      </CollapsibleTrigger>
      {(count > 1 || tools.some((tool) => tool.toolDisplay?.detail || tool.toolDisplay?.preview)) && (
        <CollapsibleContent className="border-t px-3 py-2 space-y-1">
          {tools.map((t) => {
            const ctx = toolContext(t);
            return (
              <div key={t.id} className="min-w-0 text-xs text-muted-foreground py-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <ToolStatus tool={t} />
                  <span className="shrink-0">{t.tool}</span>
                  {ctx && <span className="break-all font-mono">{ctx}</span>}
                </div>
                {t.toolDisplay?.detail && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono">{t.toolDisplay.detail}</pre>}
              </div>
            );
          })}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
