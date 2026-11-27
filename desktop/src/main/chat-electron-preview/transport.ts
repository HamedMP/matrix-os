import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v4";
import {
  CanonicalChatDetailResponseSchema, CanonicalChatIdSchema, CanonicalChatRunIdSchema,
  CanonicalChatSafeErrorSchema, CanonicalChatTurnAdmissionResponseSchema, CanonicalCreateChatTurnRequestSchema,
  FileReadResponseSchema, WorktreeIdSchema, chatMessageVersionUrl,
  type CanonicalChatDetailResponse, type CanonicalChatRun, type CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";
import {
  CHAT_ELECTRON_PREVIEW_RECEIPT_PREFIX,
  CHAT_ELECTRON_PREVIEW_BASE_LABEL, CHAT_ELECTRON_PREVIEW_MAX_AGE_MS, CHAT_ELECTRON_PREVIEW_SOURCE,
  ChatElectronPreviewMarkerSchema, getChatElectronPreviewMarkerForRun,
  isCurrentChatElectronPreviewRun, type ChatElectronPreviewMarker,
} from "../../shared/chat-electron-preview";
import { ChatElectronPreviewTarget } from "../../shared/chat-electron-preview-ipc";
import {
  getLatestCompletedMacTerminalRun, getMacTerminalProbeMarkerForRun, isCurrentMacTerminalProbeRun,
  MAC_TERMINAL_PROBE_MAX_AGE_MS, MacTerminalProbeOutputSchema, type MacTerminalProbeMarker,
} from "../../shared/mac-terminal-probe";
import type { AuthService } from "../auth/auth-service";
import { previewRequestKey } from "./claims";
import { deriveVerificationLabel } from "./source";

const MAX_CHAT_REPLY_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_REPLY_BYTES = 512 * 1024;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const PROJECT_SLUG = "matrix-os";
const TIMEOUT_MS = 15_000;
const DELIVERY_TIMEOUT_MS = 2 * 60_000;
const DELIVERY_RETRY_MS = 1_000;
const GIT_TIMEOUT_MS = 5_000;
const GIT_PREFIX = ["/usr/bin/git", "--no-optional-locks", "-c", "core.fsmonitor=false", "--no-pager"];
const OLD_PILOT_ARTIFACT = /^\?\? \.eng495-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/(?:source\.tsx|request\.json|test\.log)$/;
const ProjectReply = z.object({ project: z.object({ id: z.string(), slug: z.literal(PROJECT_SLUG) }) });
const WorktreeReply = z.object({
  worktrees: z.array(z.object({ id: WorktreeIdSchema, path: z.string().max(4096), projectSlug: z.literal(PROJECT_SLUG) })).max(4096),
});
const GitReply = z.object({
  stdout: z.string().max(64 * 1024), stderr: z.literal(""), exitCode: z.literal(0),
  signal: z.null(), timedOut: z.literal(false), truncated: z.literal(false),
});
const UploadReply = z.strictObject({ ok: z.literal(true), path: z.string(), size: z.number().int() });
const AdmissionError = z.object({ error: CanonicalChatSafeErrorSchema });
const RequestRef = z.strictObject({ chatId: CanonicalChatIdSchema, runId: CanonicalChatRunIdSchema });
const TerminalContextRef = z.strictObject({ chatId: CanonicalChatIdSchema, worktreeId: WorktreeIdSchema });
type MacTerminalContextRef = z.infer<typeof TerminalContextRef>;
const TerminalGrant = z.strictObject({ targetId: z.uuid(), approvedAt: z.number().int().nonnegative() });
type MacTerminalGrant = z.infer<typeof TerminalGrant>;
const TerminalResult = z.strictObject({
  terminalId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  output: MacTerminalProbeOutputSchema,
});
const Result = z.union([
  z.strictObject({
    png: z.instanceof(Buffer).refine(bytes => bytes.length > PNG_SIGNATURE.length
      && bytes.length <= MAX_PNG_BYTES && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)),
    testSummary: z.string().min(1).max(256).regex(/^[A-Za-z0-9 ().,:+-]+$/),
  }),
  z.strictObject({ error: z.literal("build-failed") }),
]);

export interface ChatElectronPreviewRequest {
  readonly chatId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly scopeKey: string;
  readonly baseSha: string;
  readonly sourceSha256: string;
  readonly label: string;
  readonly requestKind?: ChatElectronPreviewTarget["requestKind"];
  readonly operation?: ChatElectronPreviewMarker["operation"];
  readonly backgroundTargetId?: string;
  readonly expiresAt: number;
}

export type ChatElectronPreviewResult = z.infer<typeof Result>;

export interface MacTerminalContext {
  readonly chatId: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly scopeKey: string;
}

export interface ChatElectronPreviewBackgroundBinding {
  readonly context: MacTerminalContext;
  readonly grant: MacTerminalGrant;
  readonly signal: AbortSignal;
}

export interface MacTerminalRequest extends MacTerminalContext, MacTerminalProbeMarker {
  readonly runId: string;
  readonly expiresAt: number;
}

export class MacTerminalDeliveryRejectedError extends Error {}

export class ChatElectronPreviewTransportInterruptedError extends Error {
  constructor(cause: unknown) {
    super("Preview transport interrupted", { cause });
  }
}

function throwFetchError(error: unknown): never {
  if (error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")) {
    throw new ChatElectronPreviewTransportInterruptedError(error);
  }
  throw error;
}

type Auth = Pick<AuthService, "getStatus" | "getToken" | "getGatewayOrigin">;
type ReadOptions = { signal?: AbortSignal; retryBadGateway?: boolean };

function isInterruptedDelivery(response: Response, retryBadGateway?: boolean) {
  return retryBadGateway === true && response.status === 502;
}
interface RuntimeAuthority {
  token: string;
  origin: string;
  ownerId: string;
  authGeneration: number;
  runtimeSlot: string;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function sameAuthority(previous: RuntimeAuthority, current: RuntimeAuthority | null) {
  return current !== null && previous.origin === current.origin && previous.runtimeSlot === current.runtimeSlot
    && previous.ownerId === current.ownerId && previous.authGeneration === current.authGeneration
    && previous.token === current.token;
}

async function boundedBytes(response: Response, maximum: number) {
  const verifiedLength = Number(response.headers.get("content-length"));
  if (!response.body) throw new Error("Preview response missing");
  if (verifiedLength > maximum) {
    await response.body.cancel();
    throw new Error("Preview response too large");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(throwFetchError);
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > maximum || chunks.length >= 2048) {
        await reader.cancel();
        throw new Error("Preview response too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

async function readJson(response: Response, maximum = MAX_CHAT_REPLY_BYTES): Promise<unknown> {
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    await response.body?.cancel();
    throw new Error("Preview response was not JSON");
  }
  return JSON.parse((await boundedBytes(response, maximum)).toString("utf8"));
}

async function readAdmissionConflict(response: Response) {
  if (response.status !== 409 || !response.headers.get("content-type")?.startsWith("application/json")) {
    await response.body?.cancel();
    return undefined;
  }
  const parsed = AdmissionError.safeParse(await readJson(response, 8192));
  return parsed.success ? parsed.data.error.code : undefined;
}

function isPersonalChat(record: CanonicalChatDetailResponse["record"], ownerId: string, chatId: string) {
  const { chat } = record;
  return chat.id === chatId && chat.ownerScope.type === "personal" && chat.ownerScope.ownerId === ownerId
    && chat.collaboration === undefined && chat.lifecycle === "active";
}

function getPersonalWorktreeRun(detail: CanonicalChatDetailResponse, ownerId: string, ref: z.infer<typeof RequestRef>) {
  if (!isPersonalChat(detail.record, ownerId, ref.chatId)) return null;
  const { projectId } = detail.record;
  const run = detail.runs.find(candidate => candidate.id === ref.runId && candidate.chatId === ref.chatId);
  if (!run || run.status !== "completed" || run.driverKind !== "codex"
    || run.executionRoot?.kind !== "worktree" || run.executionRoot.projectId !== projectId
    || !WorktreeIdSchema.safeParse(run.executionRoot.worktreeId).success
    || !run.capabilitySnapshot.permissionModes.includes("supervised")
    || !run.capabilitySnapshot.interactionModes.includes("default")) return null;
  return { run, root: run.executionRoot };
}

function getPreviewCapableRun(detail: CanonicalChatDetailResponse, ownerId: string, ref: z.infer<typeof RequestRef>) {
  const candidate = getPersonalWorktreeRun(detail, ownerId, ref);
  return candidate?.run.capabilitySnapshot.attachments.includes("image") ? candidate : null;
}

function getPrivateRun(detail: CanonicalChatDetailResponse, ownerId: string, ref: z.infer<typeof RequestRef>) {
  const candidate = getPreviewCapableRun(detail, ownerId, ref);
  if (!candidate) return null;
  const marker = getChatElectronPreviewMarkerForRun(detail, candidate.run.id);
  return marker ? { ...candidate, marker } : null;
}

function hasReturned(detail: CanonicalChatDetailResponse, request: CanonicalCreateChatTurnRequest) {
  const turn = detail.turns.find(candidate => candidate.clientRequestId === request.clientRequestId);
  if (!turn) return false;
  const stored = detail.messages.find(message => message.id === turn.inputMessageId && message.role === "user");
  const text = request.parts[0];
  const attachment = request.parts[1];
  const root = detail.runs.find(run => run.turnId === turn.id)?.executionRoot;
  const approvedRoot = request.executionRoot;
  if (!stored || text?.type !== "text" || approvedRoot?.kind !== "worktree" || root?.kind !== "worktree"
    || root.projectId !== approvedRoot.projectId || root.worktreeId !== approvedRoot.worktreeId
    || !stored.parts.some(part => part.type === "text" && part.text === text.text)
    || (attachment?.type === "attachment_reference" && !stored.parts.some(part => part.type === "attachment_reference"
      && part.attachmentId === attachment.attachmentId && part.ownerReference === attachment.ownerReference))) {
    throw new Error("Preview result no longer matches its Chat receipt");
  }
  return true;
}

export function createChatElectronPreviewTransport(
  auth: Auth,
  { fetchFn = fetch, now = Date.now }: { fetchFn?: typeof fetch; now?: () => number } = {},
) {
  const bindings = new WeakMap<ChatElectronPreviewRequest, { authority: RuntimeAuthority; run: CanonicalChatRun }>();
  const terminalBindings = new WeakMap<MacTerminalContext, RuntimeAuthority>();

  function currentAuthority(): RuntimeAuthority | null {
    const status = auth.getStatus();
    const token = auth.getToken();
    if (!status.signedIn || !token || status.runtimeSlot !== "primary") return null;
    const origin = URL.parse(auth.getGatewayOrigin());
    if (!origin || origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash
      || origin.username || origin.password || origin.origin !== status.platformHost.replace(/\/$/, "")) return null;
    return { token, origin: origin.origin, ownerId: status.userId, authGeneration: status.authGeneration,
      runtimeSlot: status.runtimeSlot };
  }

  async function request(authority: RuntimeAuthority, path: string, init: RequestInit = {}) {
    init.signal?.throwIfAborted();
    if (!sameAuthority(authority, currentAuthority())) throw new Error("Preview session changed");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${authority.token}`);
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const response = await fetchFn(new URL(path, authority.origin), {
      ...init, headers, redirect: "error", signal,
    }).catch(throwFetchError);
    if (signal.aborted || !sameAuthority(authority, currentAuthority())) {
      await response.body?.cancel();
      signal.throwIfAborted();
      throw new Error("Preview session changed");
    }
    return response;
  }

  async function requestJson(authority: RuntimeAuthority, path: string, maximum?: number, init: RequestInit & ReadOptions = {}) {
    const { retryBadGateway, ...requestInit } = init;
    const response = await request(authority, path, requestInit);
    if (!response.ok) {
      await response.body?.cancel();
      if (isInterruptedDelivery(response, retryBadGateway)) {
        throw new ChatElectronPreviewTransportInterruptedError(new Error("Preview delivery revalidation returned 502"));
      }
      return null;
    }
    const data = await readJson(response, maximum);
    requestInit.signal?.throwIfAborted();
    if (!sameAuthority(authority, currentAuthority())) throw new Error("Preview session changed");
    return data;
  }

  async function readDetail(authority: RuntimeAuthority, chatId: string, options: ReadOptions) {
    const path = chatMessageVersionUrl(`/api/chats/${chatId}?limit=50`);
    const parsed = CanonicalChatDetailResponseSchema.safeParse(await requestJson(authority, path, undefined, options));
    return parsed.success ? parsed.data : null;
  }

  async function readGit(authority: RuntimeAuthority, cwd: string, args: readonly string[], options: ReadOptions) {
    const result = GitReply.safeParse(await requestJson(authority, "/api/terminal/run", 128 * 1024, {
      ...options, method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: [...GIT_PREFIX, ...args], cwd, timeoutMs: GIT_TIMEOUT_MS }),
    }));
    return result.success ? result.data.stdout : null;
  }

  async function readWorktreeCheckout(authority: RuntimeAuthority, worktreeId: string, options: ReadOptions) {
    const cwd = `worktrees/${PROJECT_SLUG}/${worktreeId}`;
    const inventory = WorktreeReply.safeParse(await requestJson(authority, `/api/projects/${PROJECT_SLUG}/worktrees`, 1024 * 1024, options));
    if (!inventory.success) return null;
    const matches = inventory.data.worktrees.filter(entry => entry.id === worktreeId);
    const checkout = matches[0]?.path;
    if (matches.length !== 1 || !checkout || !checkout.endsWith(`/${cwd}`)
      || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(checkout)
      || checkout.split("/").some(segment => segment === "." || segment === "..")) return null;
    return { checkout, cwd };
  }

  // Registry and Git identity must agree before using a Chat worktree. Command
  // arguments are fixed here. Chat contributes only the validated worktree ID.
  async function readPreviewSource(
    authority: RuntimeAuthority, worktreeId: string, verification: boolean, options: ReadOptions,
  ) {
    const registered = await readWorktreeCheckout(authority, worktreeId, options);
    if (!registered) return null;
    const { cwd, checkout } = registered;
    const head = await readGit(authority, cwd, ["rev-parse", "--show-toplevel", "HEAD"], options);
    const baseSha = head?.split("\n")[1];
    if (baseSha === undefined || !ChatElectronPreviewMarkerSchema.shape.baseSha.safeParse(baseSha).success
      || head !== `${checkout}\n${baseSha}\n`) return null;
    const status = await readGit(authority, cwd, [
      "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none",
    ], options);
    if (status === null || (status && !status.endsWith("\0"))) return null;
    const entries = status ? status.slice(0, -1).split("\0") : [];
    const edits = verification ? entries : entries.filter(entry => !OLD_PILOT_ARTIFACT.test(entry));
    const edited = edits.length === 1 && edits[0] === ` M ${CHAT_ELECTRON_PREVIEW_SOURCE}`;
    if (!edited && !(verification && edits.length === 0)) return null;

    const query = new URLSearchParams({ projectId: PROJECT_SLUG, worktreeId, path: CHAT_ELECTRON_PREVIEW_SOURCE });
    const parsed = FileReadResponseSchema.safeParse(await requestJson(
      authority, `/api/coding-agents/files/read?${query}`, MAX_SOURCE_REPLY_BYTES, options,
    ));
    if (!parsed.success || parsed.data.truncated || parsed.data.metadata.path !== CHAT_ELECTRON_PREVIEW_SOURCE) return null;
    const bytes = Buffer.from(parsed.data.content);
    if (!bytes.length || bytes.length !== parsed.data.metadata.sizeBytes) return null;
    return { cwd, baseSha, edited, bytes };
  }

  async function readVerificationManifest(authority: RuntimeAuthority, worktreeId: string, signal?: AbortSignal) {
    const source = await readPreviewSource(authority, worktreeId, true, { signal });
    if (!source) return null;
    const { cwd, baseSha, bytes, edited } = source;
    const committed = await readGit(authority, cwd, ["show", `${baseSha}:${CHAT_ELECTRON_PREVIEW_SOURCE}`], { signal });
    const label = committed === null ? null : deriveVerificationLabel(Buffer.from(committed), bytes);
    if (!label || edited !== (label !== CHAT_ELECTRON_PREVIEW_BASE_LABEL)) return null;
    return { baseSha, label, sourceSha256: sha256(bytes) };
  }

  async function verifySource(authority: RuntimeAuthority, preview: ChatElectronPreviewRequest, options: ReadOptions) {
    const verification = preview.requestKind === "verification";
    const source = await readPreviewSource(authority, preview.worktreeId, verification, options);
    return source !== null && source.baseSha === preview.baseSha && sha256(source.bytes) === preview.sourceSha256
      && (!verification || source.edited === (preview.label !== CHAT_ELECTRON_PREVIEW_BASE_LABEL));
  }

  async function verifyTerminalWorktree(authority: RuntimeAuthority, projectId: string, worktreeId: string, signal?: AbortSignal) {
    const project = ProjectReply.safeParse(await requestJson(authority, `/api/projects/${PROJECT_SLUG}`, 64 * 1024, { signal }));
    return project.success && project.data.project.id === projectId
      && (await readWorktreeCheckout(authority, worktreeId, { signal })) !== null;
  }

  function terminalContext(authority: RuntimeAuthority, chatId: string, projectId: string, worktreeId: string) {
    return { chatId, projectId, worktreeId,
      scopeKey: sha256(JSON.stringify([authority.origin, authority.ownerId, authority.runtimeSlot])) };
  }

  function isTerminalContextCurrent(context: MacTerminalContext) {
    const authority = terminalBindings.get(context);
    return !!authority && sameAuthority(authority, currentAuthority());
  }

  function isTerminalRequestCurrent(terminal: MacTerminalRequest) {
    return terminal.expiresAt > now() && isTerminalContextCurrent(terminal);
  }

  async function readLatestTerminalRequest(
    authority: RuntimeAuthority,
    chatId: string,
    expected: { runId: string } | { context: MacTerminalContext; grant: MacTerminalGrant },
    signal?: AbortSignal,
  ): Promise<MacTerminalRequest | null> {
    const detail = await readDetail(authority, chatId, { signal });
    if (!detail || detail.record.activeRun) return null;
    const latest = getLatestCompletedMacTerminalRun(detail);
    if (!latest || ("runId" in expected && latest.id !== expected.runId)) return null;
    const candidate = getPersonalWorktreeRun(detail, authority.ownerId, { chatId, runId: latest.id });
    const marker = getMacTerminalProbeMarkerForRun(detail, latest.id);
    if (!candidate || !marker || !isCurrentMacTerminalProbeRun(candidate.run, now())) return null;
    if ("runId" in expected && marker.action !== "uname") return null;
    const { projectId, worktreeId } = candidate.root;
    const completedAt = Date.parse(candidate.run.completedAt!);
    if ("grant" in expected && (marker.targetId !== expected.grant.targetId || completedAt < expected.grant.approvedAt
      || projectId !== expected.context.projectId || worktreeId !== expected.context.worktreeId)) return null;
    const expiresAt = completedAt + MAC_TERMINAL_PROBE_MAX_AGE_MS;
    if (!(await verifyTerminalWorktree(authority, projectId, worktreeId, signal)) || expiresAt <= now()) return null;
    signal?.throwIfAborted();
    const terminal = Object.freeze({ ...terminalContext(authority, chatId, projectId, worktreeId),
      runId: latest.id, ...marker, expiresAt });
    terminalBindings.set(terminal, authority);
    return terminal;
  }

  function backgroundAuthority(binding: ChatElectronPreviewBackgroundBinding) {
    const authority = terminalBindings.get(binding.context);
    return authority && sameAuthority(authority, currentAuthority()) && TerminalGrant.safeParse(binding.grant).success
      && !binding.signal.aborted ? authority : null;
  }

  function getBackgroundPreview(detail: CanonicalChatDetailResponse, authority: RuntimeAuthority, binding: ChatElectronPreviewBackgroundBinding) {
    const { context, grant } = binding;
    const latest = getLatestCompletedMacTerminalRun(detail);
    if (!latest || detail.record.activeRun) return null;
    const candidate = getPrivateRun(detail, authority.ownerId, { chatId: context.chatId, runId: latest.id });
    if (!candidate || !isCurrentChatElectronPreviewRun(candidate.run, now())
      || candidate.root.projectId !== context.projectId || candidate.root.worktreeId !== context.worktreeId
      || Date.parse(candidate.run.completedAt!) < grant.approvedAt || candidate.marker.backgroundTargetId !== grant.targetId) return null;
    return candidate;
  }

  return {
    async readTerminalContext(ref: MacTerminalContextRef, signal?: AbortSignal): Promise<MacTerminalContext | null> {
      if (!TerminalContextRef.safeParse(ref).success) return null;
      const authority = currentAuthority();
      if (!authority) return null;
      const detail = await readDetail(authority, ref.chatId, { signal });
      if (!detail || detail.record.activeRun) return null;
      const latest = getLatestCompletedMacTerminalRun(detail);
      const candidate = latest && getPersonalWorktreeRun(detail, authority.ownerId, { chatId: ref.chatId, runId: latest.id });
      if (!candidate || candidate.root.worktreeId !== ref.worktreeId) return null;
      const { projectId, worktreeId } = candidate.root;
      if (!(await verifyTerminalWorktree(authority, projectId, worktreeId, signal))) return null;
      signal?.throwIfAborted();
      const context = Object.freeze(terminalContext(authority, ref.chatId, projectId, worktreeId));
      terminalBindings.set(context, authority);
      return context;
    },

    isTerminalContextCurrent,

    async readTerminalRequest(ref: { chatId: string; runId: string }, signal?: AbortSignal): Promise<MacTerminalRequest | null> {
      if (!RequestRef.safeParse(ref).success) return null;
      const authority = currentAuthority();
      return authority ? readLatestTerminalRequest(authority, ref.chatId, ref, signal) : null;
    },

    async readBackgroundTerminalRequest(context: MacTerminalContext, grant: MacTerminalGrant, signal: AbortSignal) {
      const authority = terminalBindings.get(context);
      const approval = TerminalGrant.safeParse(grant);
      if (!authority || !sameAuthority(authority, currentAuthority()) || !approval.success) return null;
      return readLatestTerminalRequest(authority, context.chatId, { context, grant: approval.data }, signal);
    },

    async readBackgroundPreviewTarget(context: MacTerminalContext, grant: MacTerminalGrant, signal: AbortSignal) {
      const binding = { context, grant, signal };
      const authority = backgroundAuthority(binding);
      if (!authority) return null;
      const detail = await readDetail(authority, context.chatId, { signal });
      const candidate = detail && getBackgroundPreview(detail, authority, binding);
      return candidate ? { chatId: context.chatId, runId: candidate.run.id } : null;
    },

    isTerminalRequestCurrent,

    async returnTerminalResult(terminal: MacTerminalRequest, resultInput: z.infer<typeof TerminalResult>, signal?: AbortSignal): Promise<void> {
      const authority = terminalBindings.get(terminal);
      if (!authority || !isTerminalRequestCurrent(terminal)) throw new Error("Mac terminal request expired or session changed");
      const result = TerminalResult.parse(resultInput);
      if ((terminal.action === "uname") !== (result.output === "Darwin")) throw new Error("Mac terminal result action mismatch");
      const summary = result.output === "Darwin"
        ? `The approved /usr/bin/uname -s command ran in Mac terminal ${result.terminalId} and printed Darwin.`
        : `Approved commands in Mac terminal ${result.terminalId}: /usr/bin/uname -s: ${result.output.kernel} (exit 0); /usr/bin/uname -m: ${result.output.architecture} (exit 0); /usr/bin/sw_vers -productVersion: ${result.output.macOSVersion} (exit 0).`;
      const key = sha256(JSON.stringify([terminal.scopeKey, terminal.chatId, terminal.runId]));

      async function prepareTurn(binding: RuntimeAuthority) {
        const detail = await readDetail(binding, terminal.chatId, { signal });
        if (!detail) throw new Error("Mac terminal Chat could not be read");
        const candidate = getPersonalWorktreeRun(detail, binding.ownerId, terminal);
        const marker = getMacTerminalProbeMarkerForRun(detail, terminal.runId);
        if (!candidate || candidate.root.projectId !== terminal.projectId
          || candidate.root.worktreeId !== terminal.worktreeId || marker?.targetId !== terminal.targetId
          || marker.action !== terminal.action || !isTerminalRequestCurrent(terminal)) {
          throw new MacTerminalDeliveryRejectedError("Mac terminal Chat or request changed");
        }
        const turn = CanonicalCreateChatTurnRequestSchema.parse({
          clientRequestId: `req_mac_terminal_${key}`, baseRevision: detail.record.chat.revision,
          parts: [{ type: "text", text: `Mac terminal check completed for run ${terminal.runId}. ${summary} Please acknowledge the result without running commands or changing source.` }],
          executionRoot: candidate.root,
          selection: { instanceId: candidate.run.selection.instanceId, model: candidate.run.selection.model },
          interactionMode: "default", permissionMode: "supervised",
        });
        if (hasReturned(detail, turn)) return null;
        if (getLatestCompletedMacTerminalRun(detail)?.id !== terminal.runId) {
          throw new MacTerminalDeliveryRejectedError("Mac terminal Chat has moved on");
        }
        if (detail.record.activeRun) throw new Error("Mac terminal Chat has moved on");
        return turn;
      }

      const turn = await prepareTurn(authority);
      if (!turn) return;
      const path = chatMessageVersionUrl(`/api/chats/${terminal.chatId}/turns`);
      const response = await request(authority, path, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(turn), signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (!(await prepareTurn(authority))) return;
        throw new Error("Mac terminal result could not be posted");
      }
      const parsed = CanonicalChatTurnAdmissionResponseSchema.safeParse(await readJson(response));
      signal?.throwIfAborted();
      if (!parsed.success) throw new Error("Mac terminal result receipt mismatch");
      const receipt = parsed.data;
      if (!sameAuthority(authority, currentAuthority()) || !isPersonalChat(receipt.record, authority.ownerId, terminal.chatId)
        || receipt.turn.clientRequestId !== turn.clientRequestId
        || !hasReturned({ record: receipt.record, messages: [receipt.message], runs: [receipt.run],
          turns: [receipt.turn], activities: [] }, turn)) throw new Error("Mac terminal result receipt mismatch");
    },

    async read(ref: ChatElectronPreviewTarget, background?: ChatElectronPreviewBackgroundBinding, signal = background?.signal): Promise<ChatElectronPreviewRequest | null> {
      if (!ChatElectronPreviewTarget.safeParse(ref).success) return null;
      const isVerification = ref.requestKind === "verification";
      if (isVerification && background) return null;
      const authority = background ? backgroundAuthority(background) : currentAuthority();
      if (!authority) return null;
      const detail = await readDetail(authority, ref.chatId, { signal });
      if (!detail) return null;
      const marked = isVerification ? null : (background
        ? getBackgroundPreview(detail, authority, background)
        : getPrivateRun(detail, authority.ownerId, ref));
      const candidate = isVerification ? getPreviewCapableRun(detail, authority.ownerId, ref) : marked;
      if (!candidate || !isCurrentChatElectronPreviewRun(candidate.run, now())) return null;
      if (candidate.run.id !== ref.runId || Boolean(marked?.marker.backgroundTargetId) !== Boolean(background)) return null;
      if (isVerification && (detail.record.activeRun || detail.runs.at(-1)?.id !== ref.runId)) return null;
      const project = ProjectReply.safeParse(await requestJson(authority, `/api/projects/${PROJECT_SLUG}`, 64 * 1024, { signal }));
      if (!project.success || project.data.project.id !== candidate.root.projectId) return null;
      const source = marked ? marked.marker : await readVerificationManifest(authority, candidate.root.worktreeId, signal);
      if (!source) return null;
      const preview = Object.freeze({
        ...ref, projectId: candidate.root.projectId, worktreeId: candidate.root.worktreeId,
        scopeKey: sha256(JSON.stringify([authority.origin, authority.ownerId, authority.runtimeSlot])),
        baseSha: source.baseSha, sourceSha256: source.sourceSha256, label: source.label,
        operation: marked?.marker.operation,
        backgroundTargetId: marked?.marker.backgroundTargetId,
        expiresAt: Date.parse(candidate.run.completedAt!) + CHAT_ELECTRON_PREVIEW_MAX_AGE_MS,
      });
      if ((!isVerification && !(await verifySource(authority, preview, { signal }))) || preview.expiresAt <= now()) return null;
      bindings.set(preview, { authority, run: candidate.run });
      return preview;
    },

    isCurrent(preview: ChatElectronPreviewRequest) {
      const binding = bindings.get(preview);
      return !!binding && sameAuthority(binding.authority, currentAuthority());
    },

    async returnResult(
      preview: ChatElectronPreviewRequest, resultInput: ChatElectronPreviewResult, operationSignal?: AbortSignal,
    ): Promise<void> {
      const timeout = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
      const signal = operationSignal ? AbortSignal.any([operationSignal, timeout]) : timeout;
      const binding = bindings.get(preview);
      if (!binding || !sameAuthority(binding.authority, currentAuthority())) throw new Error("Preview session changed");
      const { authority, run } = binding;
      const result = Result.parse(resultInput);
      const key = previewRequestKey(preview);
      const isVerification = preview.requestKind === "verification";
      const executionRoot = { kind: "worktree" as const, projectId: preview.projectId, worktreeId: preview.worktreeId };
      let outcome: string;
      if (isVerification) {
        const trigger = `Mac Verification was requested in Chat after run ${preview.runId} completed.`;
        const snapshot = `Matrix captured the current worktree snapshot for this request. Worktree base commit ${preview.baseSha} and source SHA-256 ${preview.sourceSha256}.`;
        const status = "error" in result
          ? "Mac Verification could not build or verify the captured worktree snapshot. No screenshot was captured."
          : `Matrix independently verified the snapshot’s HEAD, tracked diff and source bytes. ${result.testSummary.replace(/\.$/, "")}. The attached image is from the Electron preview of that snapshot.`;
        outcome = `${trigger} ${snapshot} ${status}`;
      } else {
        outcome = "error" in result
          ? `Mac Electron preview build or verification failed for run ${preview.runId}. No screenshot was captured.`
          : `Mac Electron preview built for run ${preview.runId} from commit ${preview.baseSha} and source SHA-256 ${preview.sourceSha256}. Main reported passing checks. Matrix independently verified the worktree HEAD, tracked diff and source bytes. Mac verification: ${result.testSummary.replace(/\.$/, "")}. The attached image is from this preview.`;
      }
      const text = `${outcome} Please acknowledge this result without changing source. Any checkout cleanup follows the owner’s separate instructions.`;
      const parts: CanonicalCreateChatTurnRequest["parts"] = [{ type: "text", text }];
      const ownerReference = "error" in result ? null : `temporary/desktop-chat/electron-preview-${sha256(key + sha256(result.png))}.png`;
      if (ownerReference && "png" in result) {
        parts.push({ type: "attachment_reference", attachmentId: `electron_preview_${key}`, kind: "image",
          label: "Mac Electron preview.png", mimeType: "image/png", sizeBytes: result.png.length, ownerReference });
      }

      function deliveryError(response: Response, message: string) {
        const error = new Error(message);
        return isInterruptedDelivery(response, isVerification) ? new ChatElectronPreviewTransportInterruptedError(error) : error;
      }

      async function prepareTurn(retryBadGateway = isVerification) {
        const detail = await readDetail(authority, preview.chatId, { signal, retryBadGateway });
        if (!detail) throw new Error("Preview Chat or source changed");
        const marked = isVerification ? null : getPrivateRun(detail, authority.ownerId, preview);
        const candidate = isVerification ? getPreviewCapableRun(detail, authority.ownerId, preview) : marked;
        if (!candidate || candidate.root.projectId !== preview.projectId || candidate.root.worktreeId !== preview.worktreeId
          || (marked && (marked.marker.baseSha !== preview.baseSha || marked.marker.sourceSha256 !== preview.sourceSha256
          || marked.marker.label !== preview.label || marked.marker.operation !== preview.operation
          || marked.marker.backgroundTargetId !== preview.backgroundTargetId))) throw new Error("Preview Chat or source changed");
        const turn = CanonicalCreateChatTurnRequestSchema.parse({
          clientRequestId: `${CHAT_ELECTRON_PREVIEW_RECEIPT_PREFIX}${key}`, baseRevision: detail.record.chat.revision,
          parts, executionRoot, selection: { instanceId: run.selection.instanceId, model: run.selection.model },
          interactionMode: "default", permissionMode: "supervised",
        });
        if (hasReturned(detail, turn)) return null;
        if (isVerification && detail.runs.at(-1)?.id !== preview.runId) throw new Error("Preview Chat or source changed");
        return { turn, busy: Boolean(detail.record.activeRun) };
      }

      async function waitForIdleTurn() {
        let candidate = await prepareTurn();
        while (candidate?.busy) {
          await delay(DELIVERY_RETRY_MS, undefined, { signal });
          candidate = await prepareTurn();
        }
        return candidate?.turn ?? null;
      }

      const deliveryReads = { signal, retryBadGateway: isVerification };
      const initial = await waitForIdleTurn();
      if (!initial) return;
      if ((isVerification || ownerReference) && !(await verifySource(authority, preview, deliveryReads))) throw new Error("Preview source changed");
      if (ownerReference && "png" in result) {
        const path = `/api/files/blob?${new URLSearchParams({ path: ownerReference })}`;
        const uploaded = await request(authority, path, {
          method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(result.png), signal,
        });
        if (uploaded.status === 409) {
          await uploaded.body?.cancel();
          const existing = await request(authority, path, { signal });
          if (!existing.ok) {
            await existing.body?.cancel();
            throw deliveryError(existing, "Existing preview image could not be read");
          }
          if (!(await boundedBytes(existing, MAX_PNG_BYTES)).equals(result.png)) {
            throw new Error("Existing preview image does not match");
          }
        } else {
          if (!uploaded.ok) {
            await uploaded.body?.cancel();
            throw deliveryError(uploaded, "Preview image could not be saved");
          }
          const payload = UploadReply.parse(await readJson(uploaded, 8192));
          if (payload.path !== ownerReference || payload.size !== result.png.length) throw new Error("Preview image receipt mismatch");
        }
      }

      const path = chatMessageVersionUrl(`/api/chats/${preview.chatId}/turns`);
      let verifiedRevision = isVerification && ownerReference ? undefined : initial.baseRevision;
      let turn = await waitForIdleTurn();
      while (turn) {
        if ((isVerification || ownerReference) && turn.baseRevision !== verifiedRevision) {
          if (!(await verifySource(authority, preview, deliveryReads))) throw new Error("Preview source changed");
          verifiedRevision = turn.baseRevision;
          turn = await waitForIdleTurn();
          continue;
        }

        const response = await request(authority, path, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(turn), signal,
        });
        if (response.ok) {
          const receipt = CanonicalChatTurnAdmissionResponseSchema.parse(await readJson(response));
          // Stop cancels further work, but a complete authenticated receipt still records delivery.
          if (!sameAuthority(authority, currentAuthority()) || receipt.record.chat.id !== preview.chatId
            || receipt.turn.clientRequestId !== turn.clientRequestId
            || !hasReturned({ record: receipt.record, messages: [receipt.message], runs: [receipt.run],
              turns: [receipt.turn], activities: [] }, turn)) throw new Error("Preview result receipt mismatch");
          return;
        }

        const conflict = await readAdmissionConflict(response);
        const retryableConflict = conflict === "chat_busy" || conflict === "chat_conflict";
        const retryReconciliation = isInterruptedDelivery(response, isVerification) || (isVerification && retryableConflict);
        // Reconcile an already-accepted receipt, but retain a permanent POST failure
        // if the reconciliation read is itself interrupted.
        const refreshed = await prepareTurn(retryReconciliation).catch((error: unknown) => {
          if (isVerification && !retryReconciliation && error instanceof ChatElectronPreviewTransportInterruptedError) {
            throw new Error("Preview result could not be posted", { cause: error });
          }
          throw error;
        });
        if (!refreshed) return;
        // A concurrent Chat turn can win between the idle check and admission.
        // Keep the same receipt identity and reuse the single uploaded PNG.
        if (!retryableConflict || (conflict === "chat_conflict" && refreshed.turn.baseRevision === turn.baseRevision)) {
          throw deliveryError(response, "Preview result could not be posted");
        }
        verifiedRevision = undefined;
        await delay(DELIVERY_RETRY_MS, undefined, { signal });
        turn = await waitForIdleTurn();
      }
    },
  };
}
