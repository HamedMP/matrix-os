import { Alert } from "react-native";

import { AgentRequestError } from "@/lib/requests/bots";

/** Asks before archiving an agent, in the same words from its details and from its row's menu. */
export function confirmArchiveAgent(name: string, onArchive: () => void): void {
  Alert.alert(`Archive ${name}?`, "It leaves your agents list. This cannot be undone from the app.", [
    { text: "Cancel", style: "cancel" },
    { text: "Archive", style: "destructive", onPress: onArchive },
  ]);
}

/** Says an archive did not happen, and why when the person can act on it. */
export function reportArchiveAgentFailure(error: unknown): void {
  console.warn("[mobile] agent archive failed", error instanceof Error ? error.name : "unknown");
  if (error instanceof AgentRequestError && error.reason === "conflict") Alert.alert("This agent changed. Try again.");
  else Alert.alert("Agent could not be archived", "Try again.");
}
