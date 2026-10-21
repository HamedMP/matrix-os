/** A pasted Claude subscription OAuth token is caught locally, before it can leave this device. */
export function keyFormatFailure(providerId: "openai" | "anthropic" | "openrouter", apiKey: string): string | null {
  return providerId === "anthropic" && apiKey.trim().startsWith("sk-ant-oat")
    ? "This looks like a Claude subscription sign-in token, not an API key. Paste an Anthropic API key (starts with sk-ant-api), or connect with your Claude account instead."
    : null;
}

export type KeyFailureReason = "rejected" | "key_workspace_required" | "unavailable";
const KEY_PROVIDER_NAMES = { openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter" } as const;

/** Owner-facing wording for a failed API key connection. Only a provider's own
 * verdict blames the key; an uncertain failure keeps the safe status wording. */
export function keyFailureMessage(reason: KeyFailureReason, providerId: keyof typeof KEY_PROVIDER_NAMES, size: "full" | "short" = "full"): string {
  const name = KEY_PROVIDER_NAMES[providerId];
  if (reason === "rejected") return size === "short" ? `${name} didn't accept this key`
    : `${name} didn't accept this key. Check that you copied all of it, or create a new key in your ${name} account.`;
  if (reason === "key_workspace_required") return size === "short" ? "This key isn't in a workspace"
    : "This key isn't in a workspace. In the Anthropic Console, create a key inside a workspace, then paste it here.";
  return size === "short" ? "Couldn't connect right now. Try again." : "Could not confirm the connection. Check its status before trying again.";
}
