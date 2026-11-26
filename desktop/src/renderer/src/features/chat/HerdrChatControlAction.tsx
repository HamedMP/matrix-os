import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import { Button } from "@matrix-os/ui";
import { HerdrControlPicker, herdrControlCommand } from "@matrix-os/ui/herdr-sessions";
import type { ApiClient } from "../../lib/api";
import { herdrSessionsRequest } from "../terminal/herdr-desktop-session";
import type { ComposerMentionAction } from "./ComposerMentionActions";

export interface HerdrControlContext {
  api: ApiClient;
  scope: string;
  authGeneration: number;
  runtimeSlot: string;
}

export interface HerdrControlDraft {
  target: CanonicalChatResourceReference;
  isCurrent(): boolean;
  accepted(): void;
}

/** Keep the editor mounted when settings change, while discarding the previous terminal choice. */
export function HerdrChatControlAction({ control, children }: {
  control?: HerdrControlContext;
  children(action?: ComposerMentionAction, draft?: HerdrControlDraft): ReactNode;
}) {
  const api = control?.api;
  const scope = control?.scope;
  const generation = control?.authGeneration;
  const slot = control?.runtimeSlot;
  const request = useMemo(() => api && generation !== undefined && slot
    ? herdrSessionsRequest(api.forSession({ authGeneration: generation, runtimeSlot: slot })) : null, [api, generation, slot]);
  const identity = useMemo(() => request && scope ? { request, scope } : null, [request, scope]);
  const [choice, setChoice] = useState<{ identity: NonNullable<typeof identity>; target: CanonicalChatResourceReference | null } | null>(null);
  if (choice && choice.identity !== identity) setChoice(null);
  const currentChoice = choice?.identity === identity ? choice : null;
  const target = currentChoice?.target ?? null;
  const current = useRef(target);
  useLayoutEffect(() => {
    current.current = target;
    return () => { current.current = null; };
  }, [target]);
  const action: ComposerMentionAction = {
    kind: "herdr", label: "Control a Herdr terminal", keywords: "herdr terminal control",
    slashCommand: herdrControlCommand.descriptorId, consumeTrigger: true,
    select: () => { if (identity) setChoice({ identity, target: null }); },
  };
  return <>
    {identity && currentChoice && !target && <HerdrControlPicker request={identity.request} onCancel={() => setChoice(null)}
      onSelect={value => setChoice({ identity, target: value })} />}
    {target && <div className="flex items-center gap-2 px-2 pb-1 text-sm">
      <span role="status">Terminal control for this message · {target.label}</span>
      <Button type="button" variant="ghost" size="sm" onClick={() => setChoice(null)}>Remove</Button>
    </div>}
    {children(identity ? action : undefined, target ? {
      target, isCurrent: () => current.current === target,
      accepted: () => setChoice(selected => selected?.target === target ? null : selected),
    } : undefined)}
  </>;
}
