import { createHash } from "node:crypto";
import { z } from "zod/v4";
import {
  CanonicalChatDetailResponseSchema, CanonicalChatIdSchema, CanonicalChatRunIdSchema,
  CanonicalChatTurnAdmissionResponseSchema, CanonicalCreateChatTurnRequestSchema,
  FileReadResponseSchema, WorktreeIdSchema, chatMessageVersionUrl,
  type CanonicalChatDetailResponse, type CanonicalChatRun, type CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";
import {
  CHAT_ELECTRON_PREVIEW_MAX_AGE_MS, CHAT_ELECTRON_PREVIEW_SOURCE,
  getChatElectronPreviewMarkerForRun, isCurrentChatElectronPreviewRun,
} from "../../shared/chat-electron-preview";
import type { AuthService } from "../auth/auth-service";

const MAX_CHAT_REPLY_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_REPLY_BYTES = 512 * 1024;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const PROJECT_SLUG = "matrix-os";
const TIMEOUT_MS = 15_000;
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
const RequestRef = z.strictObject({ chatId: CanonicalChatIdSchema, runId: CanonicalChatRunIdSchema });
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
  readonly expiresAt: number;
}

export type ChatElectronPreviewResult = z.infer<typeof Result>;

type Auth = Pick<AuthService, "getStatus" | "getToken" | "getGatewayOrigin">;
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
      const { done, value } = await reader.read();
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

function getPrivateRun(detail: CanonicalChatDetailResponse, ownerId: string, ref: z.infer<typeof RequestRef>) {
  const { chat, projectId } = detail.record;
  if (chat.id !== ref.chatId || chat.ownerScope.type !== "personal" || chat.ownerScope.ownerId !== ownerId
    || chat.collaboration !== undefined || chat.lifecycle !== "active") return null;
  const run = detail.runs.find(candidate => candidate.id === ref.runId);
  if (!run || run.status !== "completed" || run.driverKind !== "codex"
    || run.executionRoot?.kind !== "worktree" || run.executionRoot.projectId !== projectId
    || !WorktreeIdSchema.safeParse(run.executionRoot.worktreeId).success
    || !run.capabilitySnapshot.permissionModes.includes("supervised")
    || !run.capabilitySnapshot.interactionModes.includes("default")
    || !run.capabilitySnapshot.attachments.includes("image")) return null;
  const marker = getChatElectronPreviewMarkerForRun(detail, run.id);
  return marker ? { run, root: run.executionRoot, marker } : null;
}

function matchingBytes(request: ChatElectronPreviewRequest, content: z.infer<typeof FileReadResponseSchema>) {
  return content.metadata.path === CHAT_ELECTRON_PREVIEW_SOURCE && !content.truncated
    && Buffer.byteLength(content.content) === content.metadata.sizeBytes
    && sha256(content.content) === request.sourceSha256;
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
    if (!sameAuthority(authority, currentAuthority())) throw new Error("Preview session changed");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${authority.token}`);
    const response = await fetchFn(new URL(path, authority.origin), {
      ...init, headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!sameAuthority(authority, currentAuthority())) {
      await response.body?.cancel();
      throw new Error("Preview session changed");
    }
    return response;
  }

  async function requestJson(authority: RuntimeAuthority, path: string, maximum?: number, init?: RequestInit) {
    const response = await request(authority, path, init);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const data = await readJson(response, maximum);
    if (!sameAuthority(authority, currentAuthority())) throw new Error("Preview session changed");
    return data;
  }

  async function readDetail(authority: RuntimeAuthority, chatId: string) {
    const path = chatMessageVersionUrl(`/api/chats/${chatId}?limit=50`);
    const parsed = CanonicalChatDetailResponseSchema.safeParse(await requestJson(authority, path));
    return parsed.success ? parsed.data : null;
  }

  async function readGit(authority: RuntimeAuthority, cwd: string, args: readonly string[]) {
    const result = GitReply.safeParse(await requestJson(authority, "/api/terminal/run", 128 * 1024, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: [...GIT_PREFIX, ...args], cwd, timeoutMs: GIT_TIMEOUT_MS }),
    }));
    return result.success ? result.data.stdout : null;
  }

  // Registry and Git identity must agree before using a Chat worktree. Command
  // arguments are fixed here. Chat contributes only the validated worktree ID.
  async function verifySource(authority: RuntimeAuthority, preview: ChatElectronPreviewRequest) {
    const cwd = `worktrees/${PROJECT_SLUG}/${preview.worktreeId}`;
    const inventory = WorktreeReply.safeParse(await requestJson(authority, `/api/projects/${PROJECT_SLUG}/worktrees`, 1024 * 1024));
    if (!inventory.success) return false;
    const matches = inventory.data.worktrees.filter(entry => entry.id === preview.worktreeId);
    const checkout = matches[0]?.path;
    if (matches.length !== 1 || !checkout || !checkout.endsWith(`/${cwd}`)
      || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(checkout)
      || checkout.split("/").some(segment => segment === "." || segment === "..")) return false;

    const head = await readGit(authority, cwd, ["rev-parse", "--show-toplevel", "HEAD"]);
    if (head !== `${checkout}\n${preview.baseSha}\n`) return false;
    const status = await readGit(authority, cwd, [
      "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none",
    ]);
    if (!status?.endsWith("\0")) return false;
    const edits = status.slice(0, -1).split("\0").filter(entry => !OLD_PILOT_ARTIFACT.test(entry));
    if (edits.length !== 1 || edits[0] !== ` M ${CHAT_ELECTRON_PREVIEW_SOURCE}`) return false;

    const query = new URLSearchParams({ projectId: PROJECT_SLUG, worktreeId: preview.worktreeId, path: CHAT_ELECTRON_PREVIEW_SOURCE });
    const parsed = FileReadResponseSchema.safeParse(await requestJson(authority, `/api/coding-agents/files/read?${query}`, MAX_SOURCE_REPLY_BYTES));
    return parsed.success && matchingBytes(preview, parsed.data);
  }

  return {
    async read(ref: { chatId: string; runId: string }): Promise<ChatElectronPreviewRequest | null> {
      if (!RequestRef.safeParse(ref).success) return null;
      const authority = currentAuthority();
      if (!authority) return null;
      const detail = await readDetail(authority, ref.chatId);
      const candidate = detail && getPrivateRun(detail, authority.ownerId, ref);
      if (!candidate || !isCurrentChatElectronPreviewRun(candidate.run, now())) return null;
      const project = ProjectReply.safeParse(await requestJson(authority, `/api/projects/${PROJECT_SLUG}`, 64 * 1024));
      if (!project.success || project.data.project.id !== candidate.root.projectId) return null;
      const preview = Object.freeze({
        ...ref, projectId: candidate.root.projectId, worktreeId: candidate.root.worktreeId,
        scopeKey: sha256(JSON.stringify([authority.origin, authority.ownerId, authority.runtimeSlot])),
        baseSha: candidate.marker.baseSha, sourceSha256: candidate.marker.sourceSha256, label: candidate.marker.label,
        expiresAt: Date.parse(candidate.run.completedAt!) + CHAT_ELECTRON_PREVIEW_MAX_AGE_MS,
      });
      if (!(await verifySource(authority, preview)) || preview.expiresAt <= now()) return null;
      bindings.set(preview, { authority, run: candidate.run });
      return preview;
    },

    isCurrent(preview: ChatElectronPreviewRequest) {
      const binding = bindings.get(preview);
      return !!binding && sameAuthority(binding.authority, currentAuthority());
    },

    async returnResult(preview: ChatElectronPreviewRequest, resultInput: ChatElectronPreviewResult): Promise<void> {
      const binding = bindings.get(preview);
      if (!binding || !sameAuthority(binding.authority, currentAuthority())) throw new Error("Preview session changed");
      const { authority, run } = binding;
      const result = Result.parse(resultInput);
      const key = sha256(JSON.stringify([preview.scopeKey, preview.chatId, preview.runId]));
      const executionRoot = { kind: "worktree" as const, projectId: preview.projectId, worktreeId: preview.worktreeId };
      const text = "error" in result
        ? `Mac Electron preview build or verification failed for run ${preview.runId}. No screenshot was captured. Please acknowledge this result without changing source. Any checkout cleanup follows the owner’s separate instructions.`
        : `Mac Electron preview built for run ${preview.runId} from commit ${preview.baseSha} and source SHA-256 ${preview.sourceSha256}. Main reported passing checks. Main worktree HEAD, tracked diff and source bytes were independently verified. Mac verification: ${result.testSummary.replace(/\.$/, "")}. The attached image is from this preview. Please acknowledge this result without changing source. Any checkout cleanup follows the owner’s separate instructions.`;
      const parts: CanonicalCreateChatTurnRequest["parts"] = [{ type: "text", text }];
      const ownerReference = "error" in result ? null : `temporary/desktop-chat/electron-preview-${sha256(key + sha256(result.png))}.png`;
      if (ownerReference && "png" in result) {
        parts.push({ type: "attachment_reference", attachmentId: `electron_preview_${key}`, kind: "image",
          label: "Mac Electron preview.png", mimeType: "image/png", sizeBytes: result.png.length, ownerReference });
      }

      async function prepareTurn() {
        const detail = await readDetail(authority, preview.chatId);
        const candidate = detail && getPrivateRun(detail, authority.ownerId, preview);
        if (!detail || !candidate || candidate.root.projectId !== preview.projectId || candidate.root.worktreeId !== preview.worktreeId
          || candidate.marker.baseSha !== preview.baseSha || candidate.marker.sourceSha256 !== preview.sourceSha256
          || candidate.marker.label !== preview.label) throw new Error("Preview Chat or source changed");
        const turn = CanonicalCreateChatTurnRequestSchema.parse({
          clientRequestId: `req_electron_preview_${key}`, baseRevision: detail.record.chat.revision,
          parts, executionRoot, selection: { instanceId: run.selection.instanceId, model: run.selection.model },
          interactionMode: "default", permissionMode: "supervised",
        });
        if (hasReturned(detail, turn)) return null;
        if (detail.record.activeRun) throw new Error("Original Chat is busy");
        return turn;
      }

      const initial = await prepareTurn();
      if (!initial) return;
      if (ownerReference && "png" in result) {
        if (!(await verifySource(authority, preview))) throw new Error("Preview source changed");
        const path = `/api/files/blob?${new URLSearchParams({ path: ownerReference })}`;
        const uploaded = await request(authority, path, {
          method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(result.png),
        });
        if (uploaded.status === 409) {
          await uploaded.body?.cancel();
          const existing = await request(authority, path);
          if (!existing.ok) {
            await existing.body?.cancel();
            throw new Error("Existing preview image could not be read");
          }
          if (!(await boundedBytes(existing, MAX_PNG_BYTES)).equals(result.png)) {
            throw new Error("Existing preview image does not match");
          }
        } else {
          if (!uploaded.ok) {
            await uploaded.body?.cancel();
            throw new Error("Preview image could not be saved");
          }
          const payload = UploadReply.parse(await readJson(uploaded, 8192));
          if (payload.path !== ownerReference || payload.size !== result.png.length) throw new Error("Preview image receipt mismatch");
        }
      }

      const path = chatMessageVersionUrl(`/api/chats/${preview.chatId}/turns`);
      const turn = await prepareTurn();
      if (!turn) return;
      const response = await request(authority, path, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(turn),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (!(await prepareTurn())) return;
        throw new Error("Preview result could not be posted");
      }
      const receipt = CanonicalChatTurnAdmissionResponseSchema.parse(await readJson(response));
      if (!sameAuthority(authority, currentAuthority()) || receipt.record.chat.id !== preview.chatId
        || receipt.turn.clientRequestId !== turn.clientRequestId
        || !hasReturned({ record: receipt.record, messages: [receipt.message], runs: [receipt.run],
          turns: [receipt.turn], activities: [] }, turn)) throw new Error("Preview result receipt mismatch");
    },
  };
}
