"use client";
import { Building2, Share } from "lucide-react";
import { shareTriggerState, type PageMode } from "./share-model";

/** Icon + label for the window-header Share button: Share / Shared / Live. */
export function ShareTriggerLabel({ pageMode, orgShared }: { pageMode: PageMode; orgShared: boolean }) {
  const state = shareTriggerState(pageMode, orgShared);
  return <>
    {state.icon === "live" ? <span aria-hidden="true" className="mx-0.5 size-2 rounded-full bg-[#22c55e]" />
      : state.icon === "organization" ? <Building2 aria-hidden="true" className="size-[15px]" />
      : <Share aria-hidden="true" className="size-[15px]" />}
    <span>{state.label}</span>
  </>;
}
