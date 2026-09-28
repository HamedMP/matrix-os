import { createInterface } from "node:readline/promises";
import { defineCommand } from "citty";
import { requireCliAuthToken } from "../auth-state.js";
import { formatCliError, formatCliSuccess, isFetchTimeoutError } from "../output.js";
import { resolveCliProfile } from "../profiles.js";

const REQUEST_TIMEOUT_MS = 10_000;
const PR_PATTERN = /^[1-9][0-9]{0,8}$/;

interface PreviewBundle {
  pr: number;
  version: string;
  gitCommit: string;
  author: string | null;
  createdAt: string;
}

interface PrivatePreviewView {
  machineId: string;
  handle: string;
  pr: number;
  confirmedBundleVersion: string;
  status: string;
  provisionedAt: string;
  expiresAt: string | null;
}

export interface PreviewIo {
  /** Answers a yes/no question; defaults to a TTY prompt. */
  confirm?: (question: string) => Promise<boolean>;
  /** False when no one can answer a prompt; then --yes is required. */
  interactive?: boolean;
}

class PreviewCliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const STATUS_MESSAGES: Record<number, { code: string; message: string }> = {
  401: { code: "not_authenticated", message: "Not signed in. Run `matrix login` and try again." },
  403: { code: "forbidden", message: "Private Previews are available to Matrix OS team members." },
  409: { code: "invalid_state", message: "The Private Preview is not ready for that yet. Check `matrix preview list`." },
  429: { code: "quota_exceeded", message: "You already have the maximum number of Private Previews. Destroy one first." },
  502: { code: "unavailable", message: "The platform could not reach the Private Preview. Try again." },
  503: { code: "unavailable", message: "Private Previews are unavailable right now." },
};

async function request(
  args: Record<string, unknown>,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  notFoundMessage = "Not found.",
): Promise<Record<string, unknown>> {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
  let res: Response;
  try {
    res = await fetch(`${profile.platformUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw new PreviewCliError("request_failed", isFetchTimeoutError(err) ? "The platform did not respond in time." : "The platform could not be reached.");
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError)) throw err;
    data = undefined;
  }
  if (!res.ok) {
    if (res.status === 404) throw new PreviewCliError("not_found", notFoundMessage);
    // Server text never reaches the terminal; each status maps to fixed guidance.
    const known = STATUS_MESSAGES[res.status];
    if (known) throw new PreviewCliError(known.code, known.message);
    throw new PreviewCliError("request_failed", "Private Preview request failed.");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new PreviewCliError("invalid_response", "The platform returned an unexpected response.");
  }
  return data as Record<string, unknown>;
}

function parsePr(value: unknown): number {
  if (typeof value !== "string" || !PR_PATTERN.test(value)) {
    throw new PreviewCliError("invalid_argument", "Give a PR number, for example `matrix preview start 1907`.");
  }
  return Number(value);
}

function previewUrl(platformUrl: string, handle: string): string {
  return `${platformUrl}/vm/${handle}`;
}

async function bundleFor(args: Record<string, unknown>, pr: number): Promise<PreviewBundle> {
  return await request(args, "GET", `/api/private-previews/bundles?pr=${pr}`, undefined,
    `No bundle is registered for PR #${pr}. Add the preview-bundle label to the PR and wait for its build.`) as unknown as PreviewBundle;
}

async function findPreview(args: Record<string, unknown>, pr: number): Promise<PrivatePreviewView | undefined> {
  const data = await request(args, "GET", "/api/private-previews");
  const machines = Array.isArray(data.privatePreviews) ? data.privatePreviews as PrivatePreviewView[] : [];
  return machines.find((entry) => entry.pr === pr);
}

async function previewFor(args: Record<string, unknown>, pr: number): Promise<PrivatePreviewView> {
  const machine = await findPreview(args, pr);
  if (!machine) throw new PreviewCliError("not_found", `No Private Preview for PR #${pr}.`);
  return machine;
}

/** The platform keeps one Private Preview per owner and PR, on the version the owner confirmed. */
function otherBundleError(machine: PrivatePreviewView, pr: number, bundle: PreviewBundle): PreviewCliError {
  return new PreviewCliError("preview_exists",
    `Your Private Preview ${machine.handle} for PR #${pr} is confirmed for ${machine.confirmedBundleVersion}. `
    + `Run \`matrix preview update ${pr}\` to move it to ${bundle.version}.`);
}

function describeBundle(bundle: PreviewBundle): string {
  return `PR #${bundle.pr} bundle ${bundle.version} (commit ${bundle.gitCommit.slice(0, 7)}`
    + `${bundle.author ? ` by ${bundle.author}` : ""}, built ${bundle.createdAt})`;
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function canAsk(io: PreviewIo): boolean {
  return io.confirm !== undefined || (io.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
}

/**
 * The owner confirms the exact code that will run with their accounts
 * (spec 537 P3). Without a terminal, only --yes can confirm.
 */
async function confirmed(args: Record<string, unknown>, io: PreviewIo, question: string): Promise<boolean> {
  if (args.yes === true) return true;
  if (!canAsk(io)) {
    throw new PreviewCliError("confirmation_required", "Confirmation is required. Re-run with --yes to confirm.");
  }
  return await (io.confirm ?? promptYesNo)(question);
}

function errorCode(err: unknown): string {
  if (err instanceof PreviewCliError) return err.code;
  const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "request_failed";
}

function fail(args: Record<string, unknown>, err: unknown): void {
  const code = errorCode(err);
  const message = err instanceof PreviewCliError ? err.message
    : code === "not_authenticated" || code === "auth_expired"
      ? (err as Error).message
      : "Private Preview request failed.";
  console.error(args.json === true ? formatCliError(code, message) : message);
  process.exitCode = 1;
}

function succeed(args: Record<string, unknown>, data: Record<string, unknown>, lines: string[]): void {
  console.log(args.json === true ? formatCliSuccess(data) : lines.join("\n"));
}

export async function runPreviewStart(args: Record<string, unknown>, io: PreviewIo = {}): Promise<void> {
  try {
    const pr = parsePr(args.pr);
    const bundle = await bundleFor(args, pr);
    const profile = await resolveCliProfile(args);
    const existing = await findPreview(args, pr);
    if (existing) {
      if (existing.status === "failed") {
        throw new PreviewCliError("preview_failed",
          `Your Private Preview ${existing.handle} for PR #${pr} failed. Run \`matrix preview destroy ${pr}\`, then start again.`);
      }
      if (existing.confirmedBundleVersion !== bundle.version) throw otherBundleError(existing, pr, bundle);
      succeed(args, { ...existing }, [
        `You already have Private Preview ${existing.handle} for PR #${pr}, confirmed for ${bundle.version}.`,
        `Open it at ${previewUrl(profile.platformUrl, existing.handle)}.`,
      ]);
      return;
    }
    if (!await confirmed(args, io, `Start a Private Preview running ${describeBundle(bundle)} with your own accounts?`)) {
      console.log("Cancelled.");
      return;
    }
    const started = await request(args, "POST", "/api/private-previews", { pr, bundleVersion: bundle.version });
    // A concurrent start may have won with another bundle; the platform then
    // returns that machine unchanged. The start itself succeeded, so a failed
    // check only adds a hint.
    let machine: PrivatePreviewView | undefined;
    let checked = true;
    try {
      machine = await findPreview(args, pr);
    } catch (err: unknown) {
      if (!(err instanceof PreviewCliError)) throw err;
      checked = false;
    }
    if (machine && machine.confirmedBundleVersion !== bundle.version) throw otherBundleError(machine, pr, bundle);
    const handle = String(started.handle);
    succeed(args, started, [
      `Private Preview ${handle} is ${String(started.status)} for PR #${pr}.`,
      `Open it at ${previewUrl(profile.platformUrl, handle)} once it is running.`,
      ...(checked ? [] : ["Could not confirm which bundle it is on; check `matrix preview list`."]),
    ]);
  } catch (err: unknown) {
    fail(args, err);
  }
}

export async function runPreviewUpdate(args: Record<string, unknown>, io: PreviewIo = {}): Promise<void> {
  try {
    const pr = parsePr(args.pr);
    const machine = await previewFor(args, pr);
    const bundle = await bundleFor(args, pr);
    if (bundle.version === machine.confirmedBundleVersion) {
      // Confirmation is recorded before the install is requested, so a matching
      // version does not prove the machine installed it; offer to ask again.
      const note = `${machine.handle} is already confirmed for ${bundle.version}, the newest bundle for PR #${pr}.`;
      if (args.yes !== true && !canAsk(io)) {
        succeed(args, { machineId: machine.machineId, status: "confirmed", version: bundle.version }, [
          note,
          "If it is not on that version, re-run with --yes to ask it to install it again.",
        ]);
        return;
      }
      if (!await confirmed(args, io, `${note} Ask it to install that version again?`)) {
        console.log("Cancelled.");
        return;
      }
    } else if (!await confirmed(args, io, `Update ${machine.handle} to ${describeBundle(bundle)}?`)) {
      console.log("Cancelled.");
      return;
    }
    const updated = await request(args, "POST", `/api/private-previews/${machine.machineId}/deploy`, {
      bundleVersion: bundle.version,
    });
    succeed(args, updated, [`${machine.handle} is updating to ${bundle.version}.`]);
  } catch (err: unknown) {
    fail(args, err);
  }
}

export async function runPreviewDestroy(args: Record<string, unknown>, io: PreviewIo = {}): Promise<void> {
  try {
    const pr = parsePr(args.pr);
    const machine = await previewFor(args, pr);
    if (!await confirmed(args, io, `Destroy Private Preview ${machine.handle} for PR #${pr}?`)) {
      console.log("Cancelled.");
      return;
    }
    const deleted = await request(args, "DELETE", `/api/private-previews/${machine.machineId}`);
    succeed(args, deleted, [`Destroying ${machine.handle}.`]);
  } catch (err: unknown) {
    fail(args, err);
  }
}

export async function runPreviewList(args: Record<string, unknown>): Promise<void> {
  try {
    const data = await request(args, "GET", "/api/private-previews");
    const machines = Array.isArray(data.privatePreviews) ? data.privatePreviews as PrivatePreviewView[] : [];
    const profile = await resolveCliProfile(args);
    const lines = machines.length === 0
      ? ["No Private Previews. Start one with `matrix preview start <pr>`."]
      : machines.map((machine) => [
        `#${machine.pr}`,
        machine.handle,
        machine.status,
        machine.confirmedBundleVersion,
        `expires ${machine.expiresAt ?? "unknown"}`,
        previewUrl(profile.platformUrl, machine.handle),
      ].join("  "));
    succeed(args, { privatePreviews: machines }, lines);
  } catch (err: unknown) {
    fail(args, err);
  }
}

const commonArgs = {
  profile: { type: "string", required: false },
  dev: { type: "boolean", required: false, default: false },
  platform: { type: "string", required: false },
  token: { type: "string", required: false },
  json: { type: "boolean", required: false, default: false },
} as const;
const prArgs = {
  ...commonArgs,
  pr: { type: "positional", required: true, description: "Pull request number" },
  yes: { type: "boolean", required: false, default: false, description: "Confirm without prompting" },
} as const;

export const previewCommand = defineCommand({
  meta: {
    name: "preview",
    description: "Run a PR's code on your own Private Preview machine",
  },
  subCommands: {
    start: defineCommand({
      meta: { name: "start", description: "Start a Private Preview for a PR's newest bundle" },
      args: prArgs,
      run: async ({ args }) => runPreviewStart(args),
    }),
    update: defineCommand({
      meta: { name: "update", description: "Update a Private Preview to its PR's newest bundle" },
      args: prArgs,
      run: async ({ args }) => runPreviewUpdate(args),
    }),
    list: defineCommand({
      meta: { name: "list", description: "List your Private Previews" },
      args: commonArgs,
      run: async ({ args }) => runPreviewList(args),
    }),
    destroy: defineCommand({
      meta: { name: "destroy", description: "Destroy the Private Preview for a PR" },
      args: prArgs,
      run: async ({ args }) => runPreviewDestroy(args),
    }),
  },
});
