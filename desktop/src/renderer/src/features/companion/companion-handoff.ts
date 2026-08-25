import { onEvent } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useHermesChat } from "../../stores/hermes-chat";
import { useTabs } from "../../stores/tabs";

let pendingPrompt: string | null = null;

export function openCompanionPrompt(prompt: string): boolean {
  const normalized = prompt.trim();
  if (
    normalized.length === 0
    || normalized.length > 4_000
    || useConnection.getState().status !== "signed-in"
    || useHermesChat.getState().status !== "idle"
  ) {
    return false;
  }

  useTabs.getState().openTab({ kind: "chat", title: "Hermes", closable: false });
  useHermesChat.setState({ view: "conversation" });
  useHermesChat.getState().send(normalized);
  return true;
}

export function wireCompanionPromptEvents(): () => void {
  const unwireEvent = onEvent("companion:prompt-requested", ({ prompt }) => {
    const normalized = prompt.trim();
    if (useConnection.getState().status !== "signed-in") return;
    if (!openCompanionPrompt(normalized)) pendingPrompt = normalized;
  });
  const unwireHermes = useHermesChat.subscribe((state) => {
    if (state.status !== "idle" || !pendingPrompt) return;
    const prompt = pendingPrompt;
    pendingPrompt = null;
    openCompanionPrompt(prompt);
  });
  const unwireConnection = useConnection.subscribe((state) => {
    if (state.status !== "signed-in") pendingPrompt = null;
  });

  return () => {
    pendingPrompt = null;
    unwireEvent();
    unwireHermes();
    unwireConnection();
  };
}
