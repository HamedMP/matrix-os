import { createCodexCredentialFileProofReader } from "./codex-credential-file-proof.js";
import { bindNativeAccountMetadata } from "./native-account-metadata-binding.js";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { z } from "zod/v4";
import type { ProviderAccessSource, ProviderAccount } from "@matrix-os/contracts";

export interface CodexNativeAccountMetadata {
  accountLabel: string;
  connectionDetails?: ProviderAccount["connectionDetails"];
  authMethod: "api_key" | "terminal";
  checkedAt: string;
  staleAfter: string;
  usage?: Extract<ProviderAccessSource["usage"], { kind: "subscription_allowance" }>;
}
const AccountSchema = z.object({ account: z.discriminatedUnion("type", [
  z.object({ type: z.literal("chatgpt"), email: z.email().max(120), planType: z.string().max(64).optional(), id: z.string().max(160).optional() }),
  z.object({ type: z.literal("apiKey") }),
]).nullable() });
const WindowSchema = z.object({ usedPercent: z.number().finite().min(0).max(100), windowDurationMins: z.number().int().positive().max(525600), resetsAt: z.number().int().positive().max(253402300799).nullable().optional() });
const LimitsSchema = z.object({ rateLimits: z.unknown().optional(), rateLimitsByLimitId: z.record(z.string(), z.unknown()).nullable().optional() });
const BucketSchema = z.object({ primary: WindowSchema.nullable().optional() });

/** Only approved identity and one exact Codex allowance window cross this boundary. */
export function normalizeCodexNativeAccountMetadata(accountRaw: unknown, limitsRaw: unknown, now: Date): CodexNativeAccountMetadata | null {
  const parsed = AccountSchema.safeParse(accountRaw);
  if (!parsed.success || !parsed.data.account) return null;
  const account = parsed.data.account;
  const checkedAt = now.toISOString();
  const value: CodexNativeAccountMetadata = {
    accountLabel: account.type === "chatgpt" ? account.email : "API key",
    authMethod: account.type === "chatgpt" ? "terminal" : "api_key",
    checkedAt, staleAfter: new Date(now.getTime() + 30_000).toISOString(),
  };
  if (account.type !== "chatgpt") return value;
  const plans = { free: "ChatGPT Free", go: "ChatGPT Go", plus: "ChatGPT Plus", pro: "ChatGPT Pro", team: "ChatGPT Team", business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", edu: "ChatGPT Edu" } as const;
  const plan = account.planType && Object.hasOwn(plans, account.planType)
    ? plans[account.planType as keyof typeof plans] : undefined;
  value.connectionDetails = { email: account.email, ...(plan ? { planName: plan } : {}) };
  const limits = LimitsSchema.safeParse(limitsRaw);
  if (!limits.success) return value;
  const bucket = BucketSchema.safeParse(limits.data.rateLimitsByLimitId
    ? limits.data.rateLimitsByLimitId.codex : limits.data.rateLimits);
  if (!bucket.success || !bucket.data.primary) return value;
  const resetsAt = bucket.data.primary.resetsAt == null ? null : new Date(bucket.data.primary.resetsAt * 1000).toISOString();
  if (resetsAt !== null && Date.parse(resetsAt) <= now.getTime()) return value;
  value.usage = { kind: "subscription_allowance", authority: "provider_allowance", state: "current", scope: "account",
    usedBasisPoints: Math.round(bucket.data.primary.usedPercent * 100), resetsAt, asOf: checkedAt };
  return value;
}

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

/** Runtime-bound reader: quota reads are rate-limited; reuse requires fresh private identity proof. */
export function createCodexNativeAccountMetadataReader(input: {
  executable: string; cwd: string; environment: Record<string, string>; now?: () => Date;
  timeoutMs?: number; terminateGraceMs?: number; spawnProcess?: SpawnProcess;
  readCredentialFileProof?: () => Promise<string | null>;
}): () => Promise<CodexNativeAccountMetadata | null> {
  if (!input.environment.HOME || input.environment.HOME !== input.cwd) throw new Error("Native account runtime scope is required");
  const readCredentialFileProof = input.readCredentialFileProof ?? createCodexCredentialFileProofReader({ homePath: input.cwd, codexHome: input.environment.CODEX_HOME });
  let pending: Promise<CodexNativeAccountMetadata | null> | null = null;
  let cached: CodexNativeAccountMetadata | null = null;
  let blockedUntilExit = false;
  let lastStartedAt = -Infinity;
  let verification: Promise<CodexNativeAccountMetadata | null> | null = null;
  const principals = new WeakMap<CodexNativeAccountMetadata, string>();
  const freshAt = (value: CodexNativeAccountMetadata, time: number): boolean =>
    Date.parse(value.checkedAt) <= time && Date.parse(value.staleAfter) > time
    && (!value.usage?.resetsAt || Date.parse(value.usage.resetsAt) > time);
  const verifyProof = async (proof: string): Promise<boolean> => {
    if (!verification) verification = read(true).catch((error: unknown) => {
      cached = null;
      throw error;
    }).finally(() => { verification = null; });
    const current = await verification;
    return current !== null && principals.get(current) === proof;
  };
  const read = async (identityOnly = false): Promise<CodexNativeAccountMetadata | null> => {
    if (blockedUntilExit || (!identityOnly && verification)) return null;
    const startedAt = (input.now ?? (() => new Date()))().getTime();
    const waitMs = Math.max(0, 5000 - (startedAt - lastStartedAt));
    if (!identityOnly && waitMs > 0) return null;
    if (!identityOnly) lastStartedAt = (input.now ?? (() => new Date()))().getTime();
    // Tentative evidence precedes process startup: the app-server can cache
    // account state at spawn. It becomes usable only after effective file authority.
    const tentativeCredentialProof = await readCredentialFileProof();
    const child = (input.spawnProcess ?? spawn)(input.executable, ["app-server", "--stdio"], {
      cwd: input.cwd, env: Object.fromEntries(Object.entries(input.environment).filter(([key]) => ["HOME", "CODEX_HOME", "MATRIX_HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "MATRIX_NODE_PREFIX"].includes(key))), stdio: "pipe",
    });
    child.stderr.resume();
    return await new Promise(resolve => {
      let buffer = "";
      let bytes = 0;
      let credentialProof: string | null = null;
      let fileBackend = false;
      let account: unknown;
      let accountObservedAt: Date | undefined;
      let quota: unknown;
      let sequenceOffset = 0;
      let restarted = false;
      let outcome: CodexNativeAccountMetadata | null = null;
      let finishing = false;
      let settled = false;
      let termination: NodeJS.Timeout | undefined;
      const grace = Math.max(1, Math.min(input.terminateGraceMs ?? 250, 1000));
      const settle = () => { if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(termination); resolve(outcome); };
      const finish = (result: CodexNativeAccountMetadata | null = null) => {
        if (finishing) return;
        finishing = true; outcome = result; clearTimeout(timeout);
        const kill = (signal: NodeJS.Signals) => {
          try { child.kill(signal); } catch (error: unknown) {
            console.warn("[provider-settings] Native account process cleanup failed:", error instanceof Error ? error.name : "UnknownError");
          }
        };
        kill("SIGTERM");
        termination = setTimeout(() => {
          kill("SIGKILL");
          termination = setTimeout(() => { blockedUntilExit = true; outcome = null; settle(); }, grace);
          termination.unref();
        }, grace); termination.unref();
      };
      const timeout = setTimeout(() => finish(), Math.max(1, Math.min(input.timeoutMs ?? 4000, 5000))); timeout.unref();
      const send = (id: number, method: string, params: unknown) => { if (!finishing) child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); };
      child.once("error", () => finish());
      const onExit = () => { blockedUntilExit = false; settle(); };
      child.once("close", onExit);
      child.once("exit", () => { if (finishing) onExit(); });
      child.stdin.on("error", () => finish());
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (finishing) return;
        bytes += Buffer.byteLength(chunk); if (bytes > 64 * 1024) { finish(); return; }
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let message: { id?: number; result?: unknown; error?: unknown; method?: unknown };
          try { message = JSON.parse(line); } catch (error) { if (error instanceof SyntaxError) { finish(); return; } throw error; }
          if (!message || typeof message !== "object" || Array.isArray(message)) { finish(); return; }
          // Initial account notification can race the first account/read reply.
          // Discard the entire in-flight identity/quota sequence and retry once
          // with new IDs. Never combine an old quota reply with a new principal.
          if (message.method === "account/updated" && accountObservedAt) {
            if (restarted) { finish(); return; }
            restarted = true; sequenceOffset = 3;
            account = undefined; quota = undefined; accountObservedAt = undefined;
            send(5, "account/read", { refreshToken: false });
            continue;
          }
          if (message.id === 1) {
            if (message.error) { finish(); return; }
            child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
            send(8, "config/read", { includeLayers: false, cwd: input.cwd });
          } else if (message.id === 8) {
            const config = z.object({ config: z.object({ cli_auth_credentials_store: z.unknown().optional() }) }).safeParse(message.result);
            fileBackend = !message.error && config.success && config.data.config.cli_auth_credentials_store === "file";
            void (async () => {
              credentialProof = fileBackend ? await readCredentialFileProof() : null;
              if (fileBackend && credentialProof !== tentativeCredentialProof) { finish(); return; }
              send(2, "account/read", { refreshToken: false });
            })().catch((error: unknown) => {
              console.warn("[provider-settings] Codex private observation unavailable:", error instanceof Error ? error.name : "UnknownError");
              finish();
            });
          } else if (message.id === 2 + sequenceOffset) {
            account = message.result;
            accountObservedAt = (input.now ?? (() => new Date()))();
            if (message.error || !normalizeCodexNativeAccountMetadata(account, undefined, (input.now ?? (() => new Date()))())) { finish(); return; }
            const kind = identityOnly ? "apiKey" : AccountSchema.parse(account).account?.type;
            send((kind === "apiKey" ? 4 : 3) + sequenceOffset, kind === "apiKey" ? "account/read" : "account/rateLimits/read", kind === "apiKey" ? { refreshToken: false } : {});
          } else if (message.id === 3 + sequenceOffset) {
            quota = message.error ? undefined : message.result;
            send(4 + sequenceOffset, "account/read", { refreshToken: false });
          } else if (message.id === 4 + sequenceOffset) {
            const first = AccountSchema.safeParse(account); const last = AccountSchema.safeParse(message.result);
            if (message.error || !first.success || !last.success || JSON.stringify(first.data) !== JSON.stringify(last.data)) { finish(); return; }
            const observedAccount = account; const observedOffset = sequenceOffset;
            void (async () => {
              const finalCredentialProof = fileBackend ? await readCredentialFileProof() : null;
              if (finishing || observedAccount !== account || observedOffset !== sequenceOffset) return;
              if (credentialProof !== finalCredentialProof) { finish(); return; }
              const value = normalizeCodexNativeAccountMetadata(observedAccount, quota, (input.now ?? (() => new Date()))());
              const principal = first.data.account;
              if (value && (principal?.type === "apiKey" || principal?.type === "chatgpt" && (principal.id || credentialProof))) {
                const proof = JSON.stringify({ principal, ...(credentialProof ? { credentialProof } : {}) });
                principals.set(value, proof);
                bindNativeAccountMetadata(value, async () => {
                  // Public reads never call a bound verifier, so waiting here
                  // cannot cycle. A cooldown read has its own private proof check.
                  if (pending) {
                    const observed = await pending;
                    if (!observed || principals.get(observed) !== proof) return false;
                  }
                  if (!freshAt(value, (input.now ?? (() => new Date()))().getTime())) return false;
                  const valid = await verifyProof(proof)
                    && freshAt(value, (input.now ?? (() => new Date()))().getTime());
                  if (!valid && cached === value) cached = null;
                  return valid;
                });
              }
              finish(value);
            })().catch((error: unknown) => {
              console.warn("[provider-settings] Codex private observation unavailable:", error instanceof Error ? error.name : "UnknownError");
              finish();
            });
          }
        }
      });
      send(1, "initialize", { clientInfo: { name: "matrix-os-settings", version: "1.0.0" }, capabilities: {} });
    });
  };
  return () => {
    if (!pending) pending = (async () => {
      const time = (input.now ?? (() => new Date()))().getTime();
      if (time - lastStartedAt < 5000) {
        const value = cached;
        const proof = value && principals.get(value);
        if (value && proof && freshAt(value, time) && await verifyProof(proof)
          && freshAt(value, (input.now ?? (() => new Date()))().getTime())) return value;
        cached = null;
        return null;
      }
      const value = await read();
      cached = value && principals.has(value) ? value : null;
      return value;
    })().catch((error: unknown) => {
      cached = null;
      console.warn("[provider-settings] Native account metadata unavailable:", error instanceof Error ? error.name : "UnknownError");
      return null;
    }).finally(() => { pending = null; });
    return pending;
  };
}
