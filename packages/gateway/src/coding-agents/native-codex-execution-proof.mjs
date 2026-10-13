import { nativeCodexConfigurationFingerprint } from "./native-codex-configuration-fingerprint.mjs";
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { createCodexCredentialFileProofReader } from "./codex-credential-file-proof.mjs";
const Account = z.object({ type: z.literal("chatgpt"), email: z.email().max(120), planType: z.string().max(64).optional(), id: z.string().max(160).optional() });

/** Equality is not consent: caller supplies a server-admitted fingerprint and
 * each check reacquires the effective native configuration and principal. */
const Consent = z.object({ revision: z.number().int().nonnegative(),
  harnessInstanceId: z.string().min(1).max(128), accountId: z.string().min(1).max(128),
    configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Saved consent is checked in the child, after async Terminal/background acquisition.
 * The principal alone remains unchanged after Off or a logout/reconnect cycle. */
async function assertSavedConsent(expected, consent, environment) {
  const marker = join(environment.HOME, "system/ai-providers/codex-execution-revocation.json");
  const assertNoRevocation = async () => {
    try { await lstat(marker); }
    catch (error) { if (error?.code === "ENOENT") return; throw new Error("native_subscription_unavailable"); }
    throw new Error("native_subscription_unavailable");
  };
  await assertNoRevocation();
  const file = await open(join(environment.HOME, "system/ai-providers/settings.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("native_subscription_unavailable");
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size || bytesRead > 1024 * 1024) throw new Error("native_subscription_unavailable");
    const config = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (!Array.isArray(config?.harnesses) || config.harnesses.length > 128) throw new Error("native_subscription_unavailable");
    const rows = config.harnesses.filter(row => row?.harness === "codex");
    const row = rows[0];
    if (rows.length !== 1 || row.id !== consent.harnessInstanceId || row.enabled !== true
      || row.accessSourceId !== "owner_openai_profile" || row.selectedAccountId !== consent.accountId
      || row.nativeAccountGeneration !== expected || row.nativeAccountConsentRevision !== consent.revision
      || nativeCodexConfigurationFingerprint(row) !== consent.configurationFingerprint) {
      throw new Error("native_subscription_unavailable");
    }
  } finally { await file.close(); }
  await assertNoRevocation();
}

export async function createNativeCodexExecutionProof(expected, environment, rawConsent) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? "") || !environment.HOME || !environment.CODEX_HOME) throw new Error("native_subscription_unavailable");
  const consent = Consent.parse(rawConsent);
  await assertSavedConsent(expected, consent, environment);
  const readProof = createCodexCredentialFileProofReader({ homePath: environment.HOME, codexHome: environment.CODEX_HOME });
  // Captured before spawn because a provider can cache account state at startup.
  const initialFileProof = await readProof();
  return async request => {
    await assertSavedConsent(expected, consent, environment);
    // Without cwd, Codex reads thread-agnostic layers rather than this launch project.
    const { config } = await request("config/read", { includeLayers: false, cwd: process.cwd() });
    if (!config || config.model_provider !== "openai"
      || (config.openai_base_url != null && config.openai_base_url !== "")
      || config.chatgpt_base_url !== "https://chatgpt.com/backend-api/") throw new Error("native_subscription_unavailable");
    const fileBackend = config.cli_auth_credentials_store === "file";
    const credentialProof = fileBackend ? await readProof() : null;
    if (fileBackend && (!credentialProof || initialFileProof !== credentialProof)) throw new Error("native_subscription_unavailable");
    const { account } = await request("account/read", { refreshToken: false });
    const principal = Account.parse(account);
    if (!principal.id && !credentialProof) throw new Error("native_subscription_unavailable");
    const fingerprint = createHash("sha256").update(JSON.stringify({ principal, ...(credentialProof ? { credentialProof } : {}) })).digest("hex");
    if (fingerprint !== expected || (fileBackend && await readProof() !== credentialProof)) throw new Error("native_subscription_unavailable");
    await assertSavedConsent(expected, consent, environment);
  };
}

export function assertNativeCodexThreadProvider(started) {
  if (started?.modelProvider !== "openai") throw new Error("native_subscription_unavailable");
}

/** Human responses resume an existing provider turn just like steer. Recheck at
 * delivery, while stop/interrupt/hibernate remain available after revocation. */
export async function verifyNativeCodexHumanControl(control, verifyNativeSubscription, request) {
  if (control.type === "approval" || control.type === "input" || control.type === "defer_input") {
    await verifyNativeSubscription?.(request);
  }
}
