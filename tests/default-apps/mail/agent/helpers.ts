/**
 * Shared fixtures for Mail agent tests: a real Mail store over the scriptable
 * provider, and a scripted model that records every prompt it receives.
 */
import { createMailStore, noMailCache, type MailStore } from "../../../../home/apps/mail/src/model";
import { createMailAgentContext, type MailAgentContext } from "../../../../home/apps/mail/src/agent/context";
import { createVoiceProfileCache } from "../../../../home/apps/mail/src/agent/voice-cache";
import type { MailAi } from "../../../../home/apps/mail/src/agent/ai";
import { MAX_PROMPT_CHARS } from "../../../../home/apps/mail/src/agent/limits";
import { FakeProvider } from "../model/fake-provider";
import { GMAIL, GMAIL_FOLDERS } from "../model/fixtures";

export const quiet = () => undefined;

export class ScriptedAi implements MailAi {
  prompts: string[] = [];
  replies: Array<string | ((prompt: string) => string | Promise<string>)> = [];
  fallback: string | ((prompt: string) => string | Promise<string>) = "{}";

  async generate(prompt: string): Promise<string> {
    if (prompt.length > MAX_PROMPT_CHARS) throw new Error("prompt over the bridge limit");
    this.prompts.push(prompt);
    const next = this.replies.length ? this.replies.shift()! : this.fallback;
    return typeof next === "function" ? next(prompt) : next;
  }
}

export interface Harness {
  store: MailStore;
  gmail: FakeProvider;
  ai: ScriptedAi;
  ctx: MailAgentContext;
}

export async function harness(setup?: (gmail: FakeProvider) => void): Promise<Harness> {
  const gmail = new FakeProvider(GMAIL_FOLDERS);
  setup?.(gmail);
  const store = createMailStore({ accounts: [{ account: GMAIL, provider: gmail }], cache: noMailCache, logger: quiet, timeZone: "UTC", autosaveMs: 60_000 });
  await store.start();
  const ai = new ScriptedAi();
  const ctx = createMailAgentContext({
    ai,
    store,
    providerFor: (id) => (id === GMAIL.id ? gmail : undefined),
    voiceCache: createVoiceProfileCache(undefined, { now: () => 1000 }),
    now: () => 1000,
    logger: quiet,
  });
  return { store, gmail, ai, ctx };
}
