"use client";

import { MessageResponse } from "@/components/ai-elements/message";

export interface AoedeMarkdownProps {
  text: string;
}

/** Compact markdown for the bounded response caption in the narrow Aoede panel. */
export function AoedeMarkdown({ text }: AoedeMarkdownProps) {
  return (
    <MessageResponse
      className="h-auto min-w-0 max-h-36 w-full overflow-y-auto text-sm leading-5 [overflow-wrap:anywhere] [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_h1]:my-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:my-2 [&_h2]:text-[0.9375rem] [&_h2]:font-semibold [&_h3]:my-1.5 [&_h3]:text-sm [&_h3]:font-semibold [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_pre_code]:break-normal"
    >
      {text}
    </MessageResponse>
  );
}
