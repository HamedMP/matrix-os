"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import { Button } from "@matrix-os/ui";
import {
  HerdrControlPicker,
  requestedManagedTerminalAddress,
  type HerdrSessionsRequest,
} from "@matrix-os/ui/herdr-sessions";
import type { ManagedTerminalChatScope } from "@/hooks/managed-terminal-chat-turn";
import { ChatInput } from "./ChatInput";

type Props = ComponentProps<typeof ChatInput> & { managedTerminalScope?: ManagedTerminalChatScope };
type Choice = { key: string; target?: CanonicalChatResourceReference; address?: string; dismissed?: true };

export function ManagedTerminalChatInput({ managedTerminalScope, matrixGatewayUrl: gatewayUrl, ...props }: Props) {
  const request = useMemo<HerdrSessionsRequest | undefined>(() => gatewayUrl
    ? (path, init) => fetch(`${gatewayUrl}${path}`, { method: init.method, signal: init.signal })
    : undefined, [gatewayUrl]);
  const requestedTarget = requestedManagedTerminalAddress(props.composer.text);
  const scope = managedTerminalScope && request && !props.setupAnswer && props.connected && !props.busy && props.permissionMode === "full_access"
    ? managedTerminalScope : undefined;
  const key = scope ? JSON.stringify([props.scope, gatewayUrl, scope, props.composer.permissionIdentity, requestedTarget]) : null;
  const [choice, setChoice] = useState<Choice | null>(null);
  const selected = choice?.key === key ? choice : null;
  if (choice && !selected) setChoice(null);
  const choosing = Boolean(key && (selected || requestedTarget) && !selected?.target && !selected?.dismissed);
  const current = useRef<Choice | null>(null);
  useLayoutEffect(() => {
    current.current = selected;
    return () => { current.current = null; };
  }, [selected]);
  const dismiss = () => setChoice(key && requestedTarget ? { key, dismissed: true } : null);
  const onSubmit: Props["onSubmit"] = (text, files, options) => {
    if (choosing) return Promise.resolve(false);
    if (!selected?.target || options?.retrySubmission) return props.onSubmit(text, files, options);
    if (!scope || current.current !== selected || (props.isCurrentAuthority && !props.isCurrentAuthority())) {
      return Promise.resolve(false);
    }
    current.current = null;
    setChoice(null);
    return props.onSubmit(text, files, {
      ...options,
      managedTerminalControl: { ...scope, target: selected.target },
    });
  };

  return <>
    {key && choosing && request && <HerdrControlPicker key={key} managedOnly request={request}
      requestedTarget={requestedTarget} onCancel={dismiss}
      onSelect={(target, address) => setChoice({ key, target, address })} />}
    {selected?.target && <div className="flex items-center gap-2 px-2 pb-1 text-sm">
      <span role="status">Terminal control for this message · {selected.target.label} ({selected.address})</span>
      <Button type="button" variant="ghost" size="sm" onClick={dismiss}>Remove</Button>
    </div>}
    <ChatInput {...props} matrixGatewayUrl={gatewayUrl} onSubmit={onSubmit} terminalControlPending={choosing}
      onChooseManagedTerminal={key ? () => setChoice({ key }) : undefined} />
  </>;
}
