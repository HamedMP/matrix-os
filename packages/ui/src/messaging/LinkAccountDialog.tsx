import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  MESSAGING_BRIDGE_FIELD_VALUE_MAX,
  type MessagingBridgeLinkProgress,
  type MessagingBridgeLoginField,
  type MessagingBridgeLoginStep,
  type MessagingBridgeNetwork,
} from "@matrix-os/contracts/messaging-bridge";
import { Button } from "../Button.js";
import { Dialog } from "../Dialog.js";
import { DialogFooter } from "../DialogFooter.js";
import { DialogTitle } from "../DialogTitle.js";
import { Input } from "../Input.js";
import { bridgeErrorText, isBridgeAbort, MessagingBridgeClientError, type MessagingBridgeClient } from "./bridge-client.js";
import { linkFailureMessage, needsUnofficialWarning, networkLabel } from "./bridge-view.js";
import { chatAppsStyles as s } from "./chat-apps-styles.js";
import { QrCode } from "./QrCode.js";

type WaitStep = Extract<MessagingBridgeLoginStep, { type: "display_and_wait" }>;
type InputStep = Extract<MessagingBridgeLoginStep, { type: "user_input" }>;

type Phase =
  | { kind: "intro" }
  | { kind: "starting" }
  | { kind: "wait"; linkId: string; step: WaitStep }
  | { kind: "input"; linkId: string; step: InputStep; submitting: boolean; error: string | null }
  | { kind: "failed"; message: string };

/** Client-side long-poll timeouts tolerated in a row before the dialog gives up. */
const MAX_CONSECUTIVE_POLL_TIMEOUTS = 3;

export interface LinkAccountDialogProps {
  network: MessagingBridgeNetwork;
  client: MessagingBridgeClient;
  onClose: () => void;
  onLinked: () => void;
  onOpenExternal?: (url: string) => Promise<void> | void;
}

/**
 * Drives the normalized login-step union. Contains no per-network branches
 * apart from the up-front unofficial-connection warning.
 */
export function LinkAccountDialog({ network, client, onClose, onLinked, onOpenExternal }: LinkAccountDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const controller = useRef<AbortController | null>(null);
  /** The server-side link still open, if any; released on close so it does not wait out its TTL. */
  const openLink = useRef<string | null>(null);
  const label = networkLabel(network);

  const release = () => {
    controller.current?.abort();
    const linkId = openLink.current;
    openLink.current = null;
    if (!linkId) return;
    void client.cancelLink(network, linkId).catch((error: unknown) => {
      console.warn("[messaging] Link cancel failed", error instanceof MessagingBridgeClientError ? error.code : "UnknownError");
    });
  };

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- unmount-only cleanup; release reads refs and the client, which is fixed for this dialog
  useEffect(() => () => release(), []);

  const close = () => {
    release();
    onClose();
  };

  const follow = async (first: MessagingBridgeLinkProgress, signal: AbortSignal) => {
    let current = first;
    let timeouts = 0;
    while (!signal.aborted) {
      const step = current.step;
      openLink.current = step.type === "complete" || step.type === "failed" ? null : current.linkId;
      if (step.type === "complete") {
        onLinked();
        return;
      }
      if (step.type === "failed") {
        setPhase({ kind: "failed", message: linkFailureMessage(step.reason) });
        return;
      }
      if (step.type === "user_input") {
        setPhase({ kind: "input", linkId: current.linkId, step, submitting: false, error: null });
        return;
      }
      setPhase({ kind: "wait", linkId: current.linkId, step });
      try {
        current = await client.linkStep(network, current.linkId, { stepId: step.stepId }, signal);
        timeouts = 0;
      } catch (error: unknown) {
        if (isBridgeAbort(error) || signal.aborted) return;
        if (error instanceof MessagingBridgeClientError && error.code === "timeout" && ++timeouts < MAX_CONSECUTIVE_POLL_TIMEOUTS) continue;
        setPhase({ kind: "failed", message: bridgeErrorText(error) });
        return;
      }
    }
  };

  const start = async () => {
    release();
    const next = new AbortController();
    controller.current = next;
    setPhase({ kind: "starting" });
    try {
      const progress = await client.startLink(network, next.signal);
      await follow(progress, next.signal);
    } catch (error: unknown) {
      if (isBridgeAbort(error) || next.signal.aborted) return;
      setPhase({ kind: "failed", message: bridgeErrorText(error) });
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>, linkId: string, step: InputStep) => {
    event.preventDefault();
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    const form = new FormData(event.currentTarget);
    const fields: Record<string, string> = {};
    for (const field of step.fields) {
      const value = form.get(field.id);
      if (typeof value === "string" && value.length > 0) fields[field.id] = field.kind === "secret" ? value : value.trim();
    }
    setPhase({ kind: "input", linkId, step, submitting: true, error: null });
    try {
      const progress = await client.linkStep(network, linkId, { stepId: step.stepId, fields }, signal);
      await follow(progress, signal);
    } catch (error: unknown) {
      if (isBridgeAbort(error) || signal.aborted) return;
      setPhase({ kind: "input", linkId, step, submitting: false, error: bridgeErrorText(error) });
    }
  };

  return (
    <Dialog open onClose={close} aria-label={`Connect ${label}`} className="ph-no-capture">
      <DialogTitle>Connect {label}</DialogTitle>
      {phase.kind === "intro" ? (
        <div style={s.stack}>
          {needsUnofficialWarning(network) ? (
            <p role="note" style={s.body}>
              {label} linking uses an unofficial connection. {label} may warn you about it or restrict your account.
            </p>
          ) : null}
          <p style={s.muted}>Matrix will show you the steps {label} needs to link your account.</p>
          <DialogFooter>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button onClick={() => { void start(); }}>Continue</Button>
          </DialogFooter>
        </div>
      ) : null}
      {phase.kind === "starting" ? (
        <div style={s.stack}>
          <p role="status" style={s.body}>Connecting to {label}…</p>
          <p style={s.muted}>This can take up to a minute.</p>
          <DialogFooter><Button variant="secondary" onClick={close}>Cancel</Button></DialogFooter>
        </div>
      ) : null}
      {phase.kind === "wait" ? <WaitStepView step={phase.step} label={label} onCancel={close} /> : null}
      {phase.kind === "input" ? (
        <form onSubmit={(event) => { void submit(event, phase.linkId, phase.step); }} style={s.stack}>
          {phase.step.instructions ? <p style={s.body}>{phase.step.instructions}</p> : null}
          {phase.step.helpUrl?.startsWith("https://") ? (
            <HelpLink url={phase.step.helpUrl} onOpenExternal={onOpenExternal} />
          ) : null}
          {phase.step.fields.map((field) => <LoginField key={`${phase.step.stepId}:${field.id}`} field={field} disabled={phase.submitting} />)}
          {phase.error ? <p role="alert" style={{ ...s.body, color: "var(--matrix-destructive)" }}>{phase.error}</p> : null}
          <DialogFooter>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={phase.submitting}>{phase.submitting ? "Checking…" : "Continue"}</Button>
          </DialogFooter>
        </form>
      ) : null}
      {phase.kind === "failed" ? (
        <div style={s.stack}>
          <p role="alert" style={s.body}>{phase.message}</p>
          <DialogFooter>
            <Button variant="secondary" onClick={close}>Close</Button>
            <Button onClick={() => { void start(); }}>Try again</Button>
          </DialogFooter>
        </div>
      ) : null}
    </Dialog>
  );
}

function WaitStepView({ step, label, onCancel }: { step: WaitStep; label: string; onCancel: () => void }) {
  const data = step.display.data;
  return (
    <div style={s.stack}>
      {step.instructions ? <p style={s.body}>{step.instructions}</p> : null}
      {step.display.kind === "qr" && data ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 8 }}>
          <QrCode value={data} label={`${label} link QR code`} />
        </div>
      ) : null}
      {step.display.kind === "code" && data ? (
        <p
          aria-label="Pairing code"
          style={{ fontFamily: "var(--matrix-font-mono)", fontSize: "1.75rem", fontWeight: 600, letterSpacing: "0.12em", textAlign: "center", margin: "12px 0" }}
        >
          {data}
        </p>
      ) : null}
      <p role="status" style={s.muted}>Waiting for {label}…</p>
      <DialogFooter><Button variant="secondary" onClick={onCancel}>Cancel</Button></DialogFooter>
    </div>
  );
}

type TextFieldKind = Exclude<MessagingBridgeLoginField["kind"], "choice">;

const FIELD_INPUT: Record<TextFieldKind, { type: string; autoComplete: string; inputMode?: "tel" | "email" | "text" }> = {
  text: { type: "text", autoComplete: "off" },
  phone: { type: "tel", autoComplete: "tel", inputMode: "tel" },
  email: { type: "email", autoComplete: "email", inputMode: "email" },
  code: { type: "password", autoComplete: "one-time-code" },
  secret: { type: "password", autoComplete: "off" },
};

function LoginField({ field, disabled }: { field: MessagingBridgeLoginField; disabled: boolean }) {
  const id = `chat-app-field-${field.id}`;
  const describedBy = field.description ? `${id}-description` : undefined;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {field.kind === "choice" ? (
        <ChoiceField id={id} field={field} disabled={disabled} describedBy={describedBy} />
      ) : (
        <Input
          id={id}
          name={field.id}
          label={field.label}
          type={FIELD_INPUT[field.kind].type}
          autoComplete={FIELD_INPUT[field.kind].autoComplete}
          inputMode={FIELD_INPUT[field.kind].inputMode}
          maxLength={MESSAGING_BRIDGE_FIELD_VALUE_MAX}
          required={field.required}
          disabled={disabled}
          spellCheck={false}
          aria-describedby={describedBy}
        />
      )}
      {field.description ? <p id={describedBy} style={s.muted}>{field.description}</p> : null}
    </div>
  );
}

/**
 * A native select: the link dialog is a top-layer modal <dialog>, and the
 * shared Radix Select portals its listbox to <body>, which renders beneath it.
 */
function ChoiceField({ id, field, disabled, describedBy }: { id: string; field: MessagingBridgeLoginField; disabled: boolean; describedBy?: string }) {
  return (
    <>
      <label htmlFor={id} style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--matrix-fg)" }}>{field.label}</label>
      <select
        id={id}
        name={field.id}
        required={field.required}
        disabled={disabled}
        defaultValue=""
        aria-describedby={describedBy}
        style={{ ...s.textarea, minHeight: 40, resize: undefined }}
      >
        <option value="" disabled>Choose…</option>
        {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </>
  );
}

function HelpLink({ url, onOpenExternal }: { url: string; onOpenExternal?: (url: string) => Promise<void> | void }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{ ...s.body, color: "var(--matrix-primary)" }}
      onClick={
        onOpenExternal
          ? (event) => {
              event.preventDefault();
              void Promise.resolve(onOpenExternal(url)).catch((error: unknown) => {
                console.warn("[messaging] Help link unavailable", error instanceof Error ? error.name : "UnknownError");
              });
            }
          : undefined
      }
    >
      Open the help page
    </a>
  );
}
