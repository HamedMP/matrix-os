import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import { LEGACY_TERMINAL_CONTROL_COMMAND, TERMINAL_CONTROL_COMMAND } from "@matrix-os/contracts/herdr-terminals";
import { Button } from "@matrix-os/ui";
import { HerdrControlPicker } from "@matrix-os/ui/herdr-sessions";
import type { ApiClient } from "../../lib/api";
import { herdrSessionsRequest } from "../terminal/herdr-desktop-session";
import type { ComposerMentionAction } from "./ComposerMentionActions";

export interface HerdrControlContext {
  api: ApiClient;
  scope: string;
  authGeneration: number;
  runtimeSlot: string;
  requestedTarget?: string;
  computerName?: string;
}

export interface HerdrControlDraft {
  target: CanonicalChatResourceReference;
  isCurrent(): boolean;
  accepted(): void;
}

// The address returned by discovery is an untrusted suggestion until the owner
// selects its freshly resolved process for this one message.
export function requestedHerdrTerminal(text: string): string | undefined {
  const draft = text.trimStart();
  // A pasted address also works without an English command or a display-name guess.
  const desktop = /^(?:(?:please\s+)?(?:use\s+|select\s+)|(?:请)?(?:使用|用)\s*)?`?(desktop:[a-f0-9]{64}\/(?:machine:[a-z0-9][a-z0-9._-]{0,31}\/)?t[0-9]{1,6}[a-z]{0,2})`?(?=$|[\s,.:，。、：])/iu.exec(draft);
  if (desktop) return desktop[1]!.toLowerCase();
  const machine = /^(?:(?:please\s+)?(?:use\s+|select\s+)|(?:请)?(?:使用|用)\s*)?`?((?:machine:|herdr:)[a-z0-9][a-z0-9._-]{0,31}\/t[0-9]{1,6}[a-z]{0,2})`?(?=$|[\s,.:，。、：])/iu.exec(draft);
  if (machine) return machine[1]!.toLowerCase();
  const explicit = /^(?:please\s+)?(?:use\s+|select\s+|(?:请)?(?:使用|用)\s*)`?gateway\/([\p{L}\p{N}_-]{1,64})`?(?=$|[\s,.:，。、：])/iu.exec(draft);
  if (explicit) return explicit[1];
  // Match a short, explicit selection on *this* computer. Other phrasing is
  // handled by the agent's read-only discovery tools, which return addresses.
  const named = /^(?:please\s+)?use (?:the )?([\p{L}\p{N}_-][\p{L}\p{N} _.-]{0,63}?) terminal on this (?:computer|preview)\b/iu.exec(draft)
    ?? /^(?:请)?(?:使用|用)\s*(?:这台电脑|当前电脑|当前预览)上的\s*([\p{L}\p{N}_-][\p{L}\p{N} _.-]{0,63}?)\s*终端/u.exec(draft);
  return named?.[1]?.trim();
}

/** Keep the editor mounted when settings change, while discarding the previous terminal choice. */
export function HerdrChatControlAction({ control, children }: {
  control?: HerdrControlContext;
  children(action?: ComposerMentionAction, draft?: HerdrControlDraft, choosing?: boolean): ReactNode;
}) {
  const api = control?.api;
  const scope = control?.scope;
  const generation = control?.authGeneration;
  const slot = control?.runtimeSlot;
  const request = useMemo(() => api && generation !== undefined && slot
    ? herdrSessionsRequest(api.forSession({ authGeneration: generation, runtimeSlot: slot })) : null, [api, generation, slot]);
  const identity = useMemo(() => request && scope ? { request, scope } : null, [request, scope]);
  const requestedTarget = control?.requestedTarget;
  const [choice, setChoice] = useState<{
    identity: NonNullable<typeof identity>;
    target: CanonicalChatResourceReference | null;
    requestedTarget?: string;
    address?: string;
    dismissed?: boolean;
  } | null>(null);
  const currentChoice = choice && choice.identity === identity && choice.requestedTarget === requestedTarget ? choice : null;
  if (choice && !currentChoice) setChoice(null);
  const target = currentChoice?.target ?? null;
  const current = useRef(target);
  useLayoutEffect(() => {
    current.current = target;
    return () => { current.current = null; };
  }, [target]);
  const action: ComposerMentionAction = {
    label: "Terminal Control", keywords: "control terminal computer",
    slashCommand: TERMINAL_CONTROL_COMMAND.descriptorId,
    legacySlashCommand: LEGACY_TERMINAL_CONTROL_COMMAND.descriptorId,
    select: () => { if (identity) setChoice({ identity, target: null, requestedTarget }); },
  };
  const choosing = Boolean(identity && (currentChoice || requestedTarget) && !target && !currentChoice?.dismissed);
  const dismiss = () => setChoice(identity && requestedTarget ? { identity, requestedTarget, target: null, dismissed: true } : null);
  return <>
    {identity && choosing && <HerdrControlPicker key={JSON.stringify([identity.scope, requestedTarget])}
      request={identity.request} requestedTarget={requestedTarget} computerName={control?.computerName}
      onCancel={dismiss}
      onSelect={(value, address) => setChoice({ identity, target: value, requestedTarget, address })} />}
    {target && <div className="flex items-center gap-2 px-2 pb-1 text-sm">
      <span role="status">Terminal control for this message · {target.label}{currentChoice?.address ? ` (${currentChoice.address})` : ""}</span>
      <Button type="button" variant="ghost" size="sm" onClick={dismiss}>Remove</Button>
    </div>}
    {children(identity ? action : undefined, target ? {
      target, isCurrent: () => current.current === target,
      accepted: () => setChoice(selected => selected?.target === target ? null : selected),
    } : undefined, choosing)}
  </>;
}
