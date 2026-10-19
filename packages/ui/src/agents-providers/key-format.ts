/** A pasted Claude subscription OAuth token is caught locally, before it can leave this device. */
export function keyFormatFailure(providerId: "openai" | "anthropic" | "openrouter", apiKey: string): string | null {
  return providerId === "anthropic" && apiKey.trim().startsWith("sk-ant-oat")
    ? "This looks like a Claude subscription sign-in token, not an API key. Paste an Anthropic API key (starts with sk-ant-api), or connect with your Claude account instead."
    : null;
}
