import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { openBrowser } from "../../auth/oauth.js";
import { cliError } from "../output.js";
import { collectDevstackSourceDelta } from "./devstack-source-delta.js";
import { loadHostedSourceRun, saveHostedSourceRun, sourceRunIdSchema, type HostedSourceRun } from './devstack-source-run-state.js';

const exec = promisify(execFile);
const requestTimeoutMs = 10_000;
const maxResponseBytes = 4096;
const maxLifetimeMs = 5 * 60_000;
const clockSkewMs = 30_000;
const pollIntervalMs = 2_000;

export const hostedDevstackOrigin = "https://devstack.matrix-os.com";

const secret = z.string().length(43).regex(/^[a-zA-Z0-9_-]+$/);
const fingerprint = z.string().length(64).regex(/^[a-f0-9]+$/);
const slug = z.string().max(32).regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u)
  .refine(value => !value.includes("\n"));
const expiration = z.number().int().positive().refine(value => {
  const now = Date.now();
  return value > now && value <= now + maxLifetimeMs + clockSkewMs;
});
const approvalOriginSchema = z.string().max(256).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.port && /^[a-z0-9.-]+$/.test(url.hostname);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
});
const pairingSchema = z.object({ approvalId: secret, pollSecret: secret, expiresAt: expiration,
  approvalOrigin: approvalOriginSchema.optional() })
  .refine(value => value.approvalId !== value.pollSecret);
const grantSchema = z.object({
  bearer: secret,
  expiresAt: expiration,
  binding: z.object({ runtime: slug, worktree: slug, sourceIdentity: fingerprint, sourceSync: z.literal(true).optional(), sourceRuns: z.literal(true).optional() }),
});

const sourceReceiptSchema = z.strictObject({
  revision: fingerprint,
  files: z.number().int().nonnegative().max(50_000),
  updated: z.number().int().nonnegative().max(50_000),
  removed: z.number().int().nonnegative().max(50_000),
  test: z.strictObject({
    revision: fingerprint,
    exitCode: z.number().int().min(0).max(255),
    log: z.string().min(1).max(4096).refine(value => !/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(value)),
  }),
}).refine(value => value.test.revision === value.revision);

function invalidCheckout() {
  return cliError("devstack_selection_required", "Run this command from a Git worktree you want to connect.");
}

export async function identifyCheckout(worktree: string): Promise<string> {
  try {
    // Ignore per-process Git overrides. The filesystem identity belongs to cwd.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
    const { stdout } = await exec("git", ["-C", worktree, "rev-parse", "--show-toplevel", "--absolute-git-dir"], {
      env, timeout: 5000, maxBuffer: 8192,
    });
    const paths = stdout.replace(/\r?\n$/, "").split("\n");
    const [root, gitDir] = paths;
    if (paths.length !== 2 || !root || !gitDir || !isAbsolute(root) || !isAbsolute(gitDir) || await realpath(root) !== worktree) {
      throw invalidCheckout();
    }
    const canonicalGitDir = await realpath(gitDir);
    const [checkoutStat, gitStat] = await Promise.all([
      lstat(worktree, { bigint: true }), lstat(canonicalGitDir, { bigint: true }),
    ]);
    if (!checkoutStat.isDirectory() || !gitStat.isDirectory()) throw invalidCheckout();
    return createHash("sha256").update(JSON.stringify([
      worktree, String(checkoutStat.dev), String(checkoutStat.ino), String(checkoutStat.birthtimeNs),
      canonicalGitDir, String(gitStat.dev), String(gitStat.ino), String(gitStat.birthtimeNs),
    ])).digest("hex");
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    throw invalidCheckout();
  }
}

function invalidResponse() {
  return cliError("devstack_pairing_invalid", "DevStack returned an invalid connection response. Retry from your worktree.");
}

async function boundedJson(response: Response, maximum = maxResponseBytes): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw invalidResponse();
      }
      if (value.byteLength) chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    throw invalidResponse();
  } finally {
    reader.releaseLock();
  }
}

async function post(origin: string, endpoint: "pair" | "poll" | "source", body: object,
  timeoutMs = requestTimeoutMs, bearer?: string, headers: Record<string, string> = {}): Promise<Response> {
  try {
    return await fetch(`${origin}/devstack/cli/${endpoint}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...(bearer && { authorization: "Bearer " + bearer }), ...headers },
      body: JSON.stringify(body),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    throw cliError("devstack_pairing_unavailable", "Could not reach DevStack. Check your connection and retry.");
  }
}

export async function pairHostedStageThree({ origin, worktree, open }: {
  origin: string;
  worktree: string;
  open: boolean;
}) {
  const sourceIdentity = await identifyCheckout(worktree);
  const response = await post(origin, "pair", { sourceIdentity });
  if (response.status !== 201) {
    await response.body?.cancel();
    throw cliError("devstack_pairing_unavailable", "DevStack could not start the connection. Try again shortly.");
  }
  const pairing = pairingSchema.safeParse(await boundedJson(response));
  if (!pairing.success) throw invalidResponse();
  const { approvalId, pollSecret, expiresAt } = pairing.data;
  const approvalUrl = `${pairing.data.approvalOrigin ?? origin}/devstack/cli/pair/${approvalId}`;
  console.error(`Worktree fingerprint: ${sourceIdentity.slice(0, 12)}\nApprove this worktree in Matrix: ${approvalUrl}`);
  if (open) openBrowser(approvalUrl);

  // Pairing and access secrets stay in this CLI process.
  const deadline = Math.min(expiresAt, Date.now() + maxLifetimeMs);
  for (let remaining = deadline - Date.now(); remaining > 0; remaining = deadline - Date.now()) {
    const poll = await post(origin, "poll", { pollSecret }, Math.min(requestTimeoutMs, remaining));
    if (poll.status === 200) {
      const grant = grantSchema.safeParse(await boundedJson(poll));
      if (!grant.success || grant.data.binding.sourceIdentity !== sourceIdentity || grant.data.bearer === approvalId
          || grant.data.bearer === pollSecret || await identifyCheckout(worktree) !== sourceIdentity) {
        throw invalidResponse();
      }
      return grant.data;
    }
    await poll.body?.cancel();
    if (poll.status === 404 || poll.status === 410) break;
    if (poll.status !== 202 && poll.status !== 429) {
      throw cliError("devstack_pairing_unavailable", "DevStack could not approve this worktree. Restart the connection to try again.");
    }
    await delay(Math.min(poll.status === 429 ? 5000 : pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw cliError("devstack_pairing_expired", "DevStack approval expired. Run the command again and approve it in your browser.");
}


export async function syncHostedStageThree({ origin, worktree, grant }: {
  origin: string;
  worktree: string;
  grant: z.infer<typeof grantSchema>;
}) {
  const { binding, expiresAt, bearer } = grant;
  if (await identifyCheckout(worktree) !== binding.sourceIdentity) throw invalidCheckout();
  const delta = await collectDevstackSourceDelta(worktree);
  if (await identifyCheckout(worktree) !== binding.sourceIdentity) throw invalidCheckout();
  if (expiresAt <= Date.now()) {
    throw cliError("devstack_pairing_expired", "DevStack approval is too close to expiry. Reconnect and retry.");
  }
  const retained = binding.sourceRuns ? await saveHostedSourceRun({ origin, sourceIdentity: binding.sourceIdentity,
    runtime: binding.runtime, worktree: binding.worktree }) : undefined;
  if (retained) console.error(`DevStack runId: ${retained.runId}\nRecover with: matrix devstack result --hosted --run-id ${retained.runId}`);
  let response;
  try {
    response = await post(origin, "source", delta, 125_000, bearer, retained ? {
      'x-devstack-run-id': retained.runId, 'x-devstack-run-key': retained.key,
    } : {});
  } catch (error: unknown) {
    if (!retained) throw error;
    throw interruptedSourceRun(retained.runId);
  }
  if (retained) {
    if (response.status !== 202) {
      await response.body?.cancel();
      throw interruptedSourceRun(retained.runId);
    }
    const admitted = await readSourceRunResponse(response, retained.runId);
    if (admitted.runId !== retained.runId || admitted.runtime !== binding.runtime
      || admitted.worktree !== binding.worktree) throw interruptedSourceRun(retained.runId);
    const result = await waitForSourceRun(origin, retained, grant, true);
    const { runId, status, ...receipt } = result;
    const validated = sourceReceiptSchema.safeParse(receipt);
    if (!validated.success) throw interruptedSourceRun(retained.runId);
    return { runId, status, ...validated.data };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    if (response.status === 409) throw cliError("devstack_source_conflict", "The DevStack binding or Git baseline changed. Check the selected worktree and retry.");
    throw cliError("devstack_source_unavailable", "DevStack did not return a source result. Inspect the worktree state before retrying.");
  }
  const receipt = sourceReceiptSchema.safeParse(await boundedJson(response, 32 * 1024));
  if (!receipt.success) throw invalidResponse();
  return receipt.data;
}

const sourceRunSchema = z.strictObject({ runId: sourceRunIdSchema, runtime: slug, worktree: slug,
  status: z.enum(['running', 'succeeded', 'failed', 'timed_out', 'interrupted', 'binding_rejected']),
  receipt: sourceReceiptSchema.optional(),
}).refine(value => ['succeeded', 'failed', 'timed_out'].includes(value.status) === Boolean(value.receipt));
function interruptedSourceRun(id: string) {
  return cliError('devstack_source_run_pending', `DevStack runId ${id} has no confirmed result. Use matrix devstack result --hosted --run-id ${id}.`);
}
async function readSourceRunResponse(response: Response, runId: string) {
  try { return sourceRunSchema.parse(await boundedJson(response, 32 * 1024)); }
  catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    throw interruptedSourceRun(runId);
  }
}
export async function prepareHostedSourceResult(origin: string, worktree: string, runId: string) {
  return loadHostedSourceRun(runId, origin, await identifyCheckout(worktree));
}
export async function recoverHostedStageThree({ origin, worktree, runId, grant }: {
  origin: string; worktree: string; runId: string; grant: z.infer<typeof grantSchema>;
}) {
  const record = await prepareHostedSourceResult(origin, worktree, runId);
  return waitForSourceRun(origin, record, grant, false);
}
async function waitForSourceRun(origin: string, record: HostedSourceRun, grant: z.infer<typeof grantSchema>, wait: boolean) {
  if (!grant.binding.sourceRuns || grant.binding.sourceIdentity !== record.sourceIdentity
    || grant.binding.runtime !== record.runtime || grant.binding.worktree !== record.worktree) throw invalidResponse();
  const deadline = Math.min(Date.now() + 150_000, grant.expiresAt);
  do {
    let response: Response;
    try {
      response = await fetch(`${origin}/devstack/cli/source/${record.runId}`, { method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { accept: 'application/json', authorization: 'Bearer ' + grant.bearer, 'x-devstack-run-key': record.key },
        signal: AbortSignal.timeout(requestTimeoutMs) });
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      throw interruptedSourceRun(record.runId);
    }
    if (response.status !== 200) { await response.body?.cancel(); throw interruptedSourceRun(record.runId); }
    const result = await readSourceRunResponse(response, record.runId);
    if (result.runId !== record.runId || result.runtime !== record.runtime
      || result.worktree !== record.worktree) throw interruptedSourceRun(record.runId);
    if (!wait || result.status !== 'running') return { runId: record.runId, status: result.status, ...result.receipt };
    await delay(1000);
  } while (Date.now() < deadline);
  throw interruptedSourceRun(record.runId);
}
