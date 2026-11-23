/**
 * Whether an app may use AI, and reading a model reply safely.
 *
 * `/api/bridge/ai` answers only apps the owner allowed. A refused call does
 * not throw: the bridge resolves the gateway's JSON, which has no `text`.
 * Apps therefore ask `MatrixOS.capabilities()` before they offer the
 * assistant, and treat a reply without a string `text` as "the assistant is
 * unavailable", never as a malformed answer.
 */

import { useEffect, useState } from "react";

/** `checking` until the host answered; `denied` when the owner has not allowed AI for this app. */
export type AiAccess = "checking" | "available" | "denied" | "unavailable";

export interface AiAccessBridge {
  ai?: { generate?: unknown } | null;
  capabilities?: () => Promise<{ ai?: unknown }>;
}

/** The reply text, or null when the reply is not an answer (a refusal or an error body). */
export function replyText(reply: unknown): string | null {
  const text = (reply as { text?: unknown } | null | undefined)?.text;
  return typeof text === "string" ? text : null;
}

/** Asks the host whether this app may use AI. A host without `capabilities` is trusted to answer through `generate`. */
export async function readAiAccess(bridge: AiAccessBridge | null | undefined, log?: (message: string, error: unknown) => void): Promise<Exclude<AiAccess, "checking">> {
  if (bridge === null || bridge === undefined || bridge.ai === null || bridge.ai === undefined || typeof bridge.ai.generate !== "function") return "unavailable";
  if (typeof bridge.capabilities !== "function") return "available";
  try {
    const capabilities = await bridge.capabilities();
    return capabilities?.ai === true ? "available" : "denied";
  } catch (error: unknown) {
    log?.("the AI capability check failed", error);
    return "unavailable";
  }
}

/**
 * The AI access of an app, checked once per bridge. `assumed` skips the
 * check (a model passed in by the caller, as in tests).
 */
export function useAiAccess(bridge: AiAccessBridge | null | undefined, assumed?: AiAccess, log?: (message: string, error: unknown) => void): AiAccess {
  const [checked, setChecked] = useState<{ bridge: AiAccessBridge | null | undefined; access: AiAccess }>({ bridge, access: "checking" });
  useEffect(() => {
    if (assumed !== undefined) return undefined;
    let live = true;
    void readAiAccess(bridge, log).then((access) => {
      if (live) setChecked({ bridge, access });
    });
    return () => {
      live = false;
    };
  }, [bridge, assumed, log]);
  if (assumed !== undefined) return assumed;
  return checked.bridge === bridge ? checked.access : "checking";
}

/** What the assistant panel says when AI is not available for the app. */
export function aiAccessMessage(access: AiAccess, appName: string, slug: string): string {
  switch (access) {
    case "checking":
      return "Checking AI access…";
    case "denied":
      return `AI access is not turned on for ${appName}. The owner can allow it by adding "${slug}" to the apps list in ~/system/app-ai.json; the assistant then works here.`;
    case "unavailable":
      return "The assistant needs AI access, which is not available here.";
    default:
      return "";
  }
}
