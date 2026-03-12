"use client";

// Inspired by AI Elements chain-of-thought pattern, uses Streamdown for markdown
import type { HTMLAttributes } from "react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDownIcon } from "lucide-react";
import { MessageResponse } from "./message";

export type ReasoningProps = HTMLAttributes<HTMLDivElement> & {
  content: string;
  isStreaming?: boolean;
};

export function Reasoning({
  content,
  isStreaming = false,
  className,
  ...props
}: ReasoningProps) {
  const [open, setOpen] = useState(false);

  if (!content) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn("mb-2", className)}
        {...props}
      >
        <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <ChevronDownIcon
            className={cn(
              "size-3 transition-transform",
              open && "rotate-180",
            )}
          />
          {isStreaming ? (
            <span className="flex items-center gap-1">
              Thinking
              <ThinkingDots />
            </span>
          ) : (
            <span>Thought process</span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 border-l-2 border-muted pl-3">
            <div className="text-sm italic text-muted-foreground">
              <MessageResponse>{content}</MessageResponse>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex gap-0.5" aria-hidden="true">
      <span className="size-1 rounded-full bg-current animate-pulse" style={{ animationDelay: "0ms" }} />
      <span className="size-1 rounded-full bg-current animate-pulse" style={{ animationDelay: "150ms" }} />
      <span className="size-1 rounded-full bg-current animate-pulse" style={{ animationDelay: "300ms" }} />
    </span>
  );
}

export function extractThinking(content: string): {
  thinking: string;
  rest: string;
} {
  const thinkingMatch = content.match(
    /^<thinking>\n?([\s\S]*?)\n?<\/thinking>\n?/,
  );
  if (thinkingMatch) {
    return {
      thinking: thinkingMatch[1],
      rest: content.slice(thinkingMatch[0].length),
    };
  }
  return { thinking: "", rest: content };
}
