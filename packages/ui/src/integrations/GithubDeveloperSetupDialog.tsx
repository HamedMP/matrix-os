import { GithubDeveloperSetupOperationSchema } from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "../Button.js";
import { Dialog } from "../Dialog.js";
import { DialogFooter } from "../DialogFooter.js";
import { DialogTitle } from "../DialogTitle.js";

export const GITHUB_DEVELOPER_DEVICE_URL = "https://github.com/login/device";
const POLL_INTERVAL_MS = 1_000;
const START_REQUEST_DEADLINE_MS = 10_000;
const SETUP_DEADLINE_MS = 10 * 60_000;

export interface GithubDeveloperSetupClient {
  startSetup(signal: AbortSignal): Promise<unknown>;
  getSetup(id: string, signal: AbortSignal): Promise<unknown>;
  cancelSetup(id: string, signal: AbortSignal): Promise<unknown>;
  openSetupPage(): void | Promise<unknown>;
}

type SetupView =
  | { phase: "starting" | "finishing" | "failed" | "expired" | "cancelled" }
  | { phase: "waiting"; code: string };

function waitForNextPoll(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, POLL_INTERVAL_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function useGithubDeveloperSetup(client: GithubDeveloperSetupClient, active: boolean, refreshStatus: () => void) {
  const scope = useRef<AbortController | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [display, setDisplay] = useState<{
    client: GithubDeveloperSetupClient;
    scope: AbortSignal;
    view: SetupView;
  } | null>(null);

  useEffect(() => {
    if (!active) return;
    const lifetime = new AbortController();
    scope.current = lifetime;
    return () => {
      lifetime.abort();
      scope.current = null;
      attempt.current?.abort();
    };
  }, [active, client]);

  function dismiss() {
    attempt.current?.abort();
    setDisplay(null);
  }

  async function start() {
    const activeScope = scope.current?.signal;
    if (!active || !activeScope || activeScope.aborted || attempt.current) return;
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(SETUP_DEADLINE_MS);
    const signal = AbortSignal.any([controller.signal, deadline]);
    attempt.current = controller;
    const show = (view: SetupView) => setDisplay({ client, scope: activeScope, view });
    let id: string | undefined;
    let terminal = false;
    setPending(true);
    show({ phase: "starting" });
    try {
      // A dispatched start can create an attempt before its response arrives.
      // Keep the bounded request alive so dismissal can still cancel that ID.
      const startSignal = AbortSignal.timeout(START_REQUEST_DEADLINE_MS);
      let operation = GithubDeveloperSetupOperationSchema.parse(await client.startSetup(startSignal));
      id = operation.id;
      let failures = 0;
      let hadCode = false;
      while (!signal.aborted) {
        if (operation.state === "succeeded") {
          terminal = true;
          setDisplay(null);
          refreshStatus();
          return;
        }
        if (operation.state === "failed" || operation.state === "expired" || operation.state === "cancelled") {
          terminal = true;
          show({ phase: operation.state });
          return;
        }
        if (operation.state === "awaiting_authorization") {
          hadCode = true;
          show({ phase: "waiting", code: operation.deviceCode });
        } else {
          show({ phase: hadCode ? "finishing" : "starting" });
        }
        await waitForNextPoll(signal);
        let result: unknown;
        try {
          result = await client.getSetup(id, signal);
        } catch (error: unknown) {
          if (signal.aborted || ++failures > 2) throw error;
          continue;
        }
        operation = GithubDeveloperSetupOperationSchema.parse(result);
        if (operation.id !== id) throw new Error("GitHub Developer setup attempt changed.");
        failures = 0;
      }
    } catch (error: unknown) {
      if (!signal.aborted) {
        console.warn("[github-developer-access] Sign-in unavailable:", errorCategory(error));
        show({ phase: "failed" });
      }
    } finally {
      if (deadline.aborted && !controller.signal.aborted) show({ phase: "expired" });
      if (id && !terminal) {
        try {
          await client.cancelSetup(id, AbortSignal.timeout(3_000));
        } catch (error: unknown) {
          console.warn("[github-developer-access] Sign-in cancellation unavailable:", errorCategory(error));
        }
      }
      attempt.current = null;
      setPending(false);
    }
  }

  const view = active && display?.client === client && !display.scope.aborted ? display.view : null;
  return { view, pending, start, dismiss };
}

function errorCategory(error: unknown): string {
  if (error instanceof DOMException) return "DOMException";
  return error instanceof Error ? "Error" : typeof error;
}

function DeviceCode({ code, openPage }: { code: string; openPage: GithubDeveloperSetupClient["openSetupPage"] }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <>
    <p className="text-sm">Copy this code, then open GitHub and enter it to authorize this computer.</p>
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
      <code className="text-lg font-semibold tracking-wider">{code}</code>
      <Button variant="secondary" onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setError(null);
        } catch (error: unknown) {
          console.warn("[github-developer-access] Could not copy device code:", errorCategory(error));
          setError("Couldn't copy the code. You can select and copy it.");
        }
      }}>{copied ? "Copied" : "Copy"}</Button>
    </div>
    {error ? <p className="text-sm" role="alert">{error}</p> : null}
    <Button onClick={async () => {
      try {
        await openPage();
        setError(null);
      } catch (error: unknown) {
        console.warn("[github-developer-access] Could not open GitHub:", errorCategory(error));
        setError("Couldn't open GitHub. Try again.");
      }
    }}>Open GitHub</Button>
    <p className="text-sm" role="status">Waiting for GitHub authorization…</p>
  </>;
}

const SETUP_ERRORS = {
  failed: "Couldn't finish GitHub sign-in on this computer.",
  expired: "This GitHub code expired. Start again to get a new code.",
  cancelled: "GitHub sign-in was cancelled.",
} as const;

export function GithubDeveloperSetupDialog({ setup, openPage, canStart }: {
  setup: ReturnType<typeof useGithubDeveloperSetup>;
  openPage: GithubDeveloperSetupClient["openSetupPage"];
  canStart: boolean;
}) {
  if (!setup.view) return null;
  const { phase } = setup.view;
  const problem = phase === "starting" || phase === "waiting" || phase === "finishing" ? null : SETUP_ERRORS[phase];
  return (
    <Dialog open onClose={setup.dismiss} aria-label="Connect GitHub Developer">
      <DialogTitle>Connect GitHub Developer</DialogTitle>
      <div className="flex flex-col items-start gap-3">
        {phase === "starting" ? <p className="text-sm" role="status">Preparing GitHub sign-in…</p> : null}
        {phase === "finishing" ? <p className="text-sm" role="status">Checking the connection…</p> : null}
        {setup.view.phase === "waiting" ? <DeviceCode key={setup.view.code} code={setup.view.code} openPage={openPage} /> : null}
        {problem ? <p className="text-sm" role="alert">{problem}</p> : null}
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={setup.dismiss}>{problem ? "Close" : "Cancel"}</Button>
        {problem ? <Button onClick={() => void setup.start()} disabled={!canStart || setup.pending}>Try again</Button> : null}
      </DialogFooter>
    </Dialog>
  );
}
