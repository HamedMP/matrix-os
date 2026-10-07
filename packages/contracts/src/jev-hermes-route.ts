/** Fixed, spike-verified native Hermes routes for the isolated Inbox workflow. */
export const JEV_HERMES_PROVIDERS = ["anthropic", "openai-api", "openrouter", "openai-codex"] as const;
export type JevHermesProvider = typeof JEV_HERMES_PROVIDERS[number];
export function jevHermesRoute(selection: { instanceId: string; model: string }): { provider: JevHermesProvider; model: string } | null {
  if (selection.instanceId !== "hermes_default") return null;
  const separator = selection.model.indexOf(":");
  const provider = selection.model.slice(0, separator);
  const model = selection.model.slice(separator + 1);
  if (separator < 1 || !JEV_HERMES_PROVIDERS.some(value => value === provider)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(model)) return null;
  return { provider: provider as JevHermesProvider, model };
}
