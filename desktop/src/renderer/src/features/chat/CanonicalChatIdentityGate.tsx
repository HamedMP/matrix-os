import type { ReactNode } from "react";
import { BotBindingStatus } from "@matrix-os/ui";
import { PromptStopButton } from "./elements/prompt-input";

/** Identity gates new input; an authenticated active Run can always be stopped. */
export function CanonicalChatIdentityGate({ unknown, loading, retry, onAbort, children }: {
  unknown:boolean; loading:boolean; retry():void; onAbort?:()=>void; children:ReactNode;
}) {
  return unknown ? <div className="flex items-center justify-between gap-2">
    <BotBindingStatus loading={loading} retry={retry}/>
    {onAbort ? <PromptStopButton onAbort={onAbort}/> : null}
  </div> : children;
}
