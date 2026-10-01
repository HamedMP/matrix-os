import { createHash, randomUUID } from "node:crypto";
import {
  CollaborationScopeSchema,
  OrganizationDriveFileSchema,
  OrganizationDriveDownloadSchema,
  OrganizationDrivePathSchema,
  OrganizationDriveUploadFolderSchema,
  OrganizationDriveUploadReservationSchema,
} from "@matrix-os/contracts";
import { createCollaborationDirectClient, type CollaborationDirectClient } from "@matrix-os/ui/collaboration-direct-client";
import { z } from "zod/v4";
import { validateDriveTransferUrl } from "./organization-drive-transfer-url";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const driveBasePath = (scopeId: string) => `/api/collaboration/scopes/${scopeId}/drive`;
const RequestSchema = z.object({ scopeId: z.uuid(), organizationId: z.string().regex(/^org_[A-Za-z0-9_-]+$/),
  runtimeSlot: z.string().min(1).max(128), authGeneration: z.number().int().nonnegative(),
  folder: OrganizationDriveUploadFolderSchema }).strict();
type TransferRequest = z.infer<typeof RequestSchema>;
const DownloadRequestSchema = RequestSchema.omit({ folder: true }).extend({ fileId: z.uuid() }).strict();
type BaseResult = { status: "cancelled" } | { status: "error"; code: "unavailable" | "invalid_file" | "conflict" };
type UploadResult = BaseResult | { status: "uploaded"; fileId: string };
type DownloadResult = BaseResult | { status: "downloaded" };

interface TransferAuth {
  getToken(): string | null;
  getGatewayOrigin(): string;
  getStatus(): { signedIn: boolean; runtimeSlot: string; authGeneration: number; userId?: string };
}
interface TransferDeps {
  auth: TransferAuth;
  chooseUpload(): Promise<{ name: string; bytes: Uint8Array } | null>;
  chooseDownload(filename: string): Promise<string | null>;
  saveDownload?(destination: string, bytes: Uint8Array, canPublish: () => boolean): Promise<void>;
  fetchFn?: typeof fetch;
  validateTransferUrl?: (url: string) => Promise<void>;
  directFactory?: (options: { origin: string; token: string }) => Pick<CollaborationDirectClient, "request" | "close">;
}

export function createOrganizationDriveTransferService(deps: TransferDeps) {
  let active = false;
  let controller: AbortController | null = null;
  const makeDirect = deps.directFactory ?? (({ origin, token }: { origin: string; token: string }) =>
    createCollaborationDirectClient({ platformBaseUrl: origin, clientOrigin: new URL(origin).origin,
      getHeaders: async () => ({ Authorization: `Bearer ${token}` }) }));

  async function upload(input: TransferRequest): Promise<UploadResult> {
    const parsed = RequestSchema.safeParse(input);
    if (!parsed.success) return { status: "error", code: "unavailable" };
    if (active) return { status: "error", code: "conflict" };
    const status = deps.auth.getStatus();
    const token = deps.auth.getToken();
    const origin = deps.auth.getGatewayOrigin();
    const current = () => {
      const live = deps.auth.getStatus();
      return live.signedIn && live.runtimeSlot === parsed.data.runtimeSlot
        && live.authGeneration === parsed.data.authGeneration && live.userId === status.userId
        && deps.auth.getToken() === token && deps.auth.getGatewayOrigin() === origin;
    };
    if (!token || !current()) return { status: "cancelled" };
    let direct: ReturnType<typeof makeDirect>;
    try { direct = makeDirect({ origin, token }); }
    catch (error: unknown) {
      console.warn("[organization-drive] native session unavailable", error instanceof Error ? error.name : "UnknownError");
      return { status: "error", code: "unavailable" };
    }
    active = true;
    const operation = new AbortController();
    controller = operation;
    let reservationId: string | null = null;
    try {
      const scope = CollaborationScopeSchema.parse(await direct.request(parsed.data.scopeId, "GET",
        `/api/collaboration/scopes/${parsed.data.scopeId}`));
      if (scope.kind !== "folder" || scope.organizationId !== parsed.data.organizationId || scope.role === "viewer") {
        return { status: "error", code: "unavailable" };
      }
      const selected = await deps.chooseUpload();
      if (!current() || operation.signal.aborted) return { status: "cancelled" };
      if (!selected) return { status: "cancelled" };
      if (selected.bytes.byteLength < 1 || selected.bytes.byteLength > MAX_FILE_BYTES) {
        return { status: "error", code: "invalid_file" };
      }
      const prefix = parsed.data.folder.trim().replace(/\/$/, "");
      const path = OrganizationDrivePathSchema.safeParse(prefix ? `${prefix}/${selected.name}` : selected.name);
      if (!path.success) return { status: "error", code: "invalid_file" };
      const base = driveBasePath(parsed.data.scopeId);
      const version = z.object({ baseVersion: z.number().int().nonnegative() }).strict().parse(
        await direct.request(parsed.data.scopeId, "POST", `${base}/files/lookup`, { path: path.data }));
      if (!current() || operation.signal.aborted) return { status: "cancelled" };
      const sha256 = createHash("sha256").update(selected.bytes).digest("hex");
      const reservation = OrganizationDriveUploadReservationSchema.parse(await direct.request(parsed.data.scopeId,
        "POST", `${base}/uploads`, { path: path.data, size: selected.bytes.byteLength, sha256,
          requestId: randomUUID(), baseVersion: version.baseVersion }));
      reservationId = reservation.uploadId;
      if (!current() || operation.signal.aborted) return { status: "cancelled" };
      await (deps.validateTransferUrl ?? validateDriveTransferUrl)(reservation.putUrl);
      const response = await (deps.fetchFn ?? fetch)(reservation.putUrl, { method: "PUT", body: new Uint8Array(selected.bytes),
        redirect: "error", signal: AbortSignal.any([operation.signal, AbortSignal.timeout(15 * 60_000)]) });
      if (operation.signal.aborted || !current()) return { status: "cancelled" };
      if (!response.ok) return { status: "error", code: "unavailable" };
      if (!current() || operation.signal.aborted) return { status: "cancelled" };
      const file = OrganizationDriveFileSchema.parse(await direct.request(parsed.data.scopeId, "POST",
        `${base}/uploads/${reservationId}/commit`, {}, undefined, operation.signal));
      reservationId = null;
      if (!current() || operation.signal.aborted) return { status: "cancelled" };
      if (file.organizationId !== parsed.data.organizationId || file.path !== path.data || file.sha256 !== sha256) {
        return { status: "error", code: "unavailable" };
      }
      return { status: "uploaded", fileId: file.id };
    } catch (error: unknown) {
      if (operation.signal.aborted || !current()) return { status: "cancelled" };
      console.warn("[organization-drive] native upload failed", error instanceof Error ? error.name : "UnknownError");
      return { status: "error", code: "unavailable" };
    } finally {
      if (reservationId) {
        await direct.request(parsed.data.scopeId, "DELETE",
          `${driveBasePath(parsed.data.scopeId)}/uploads/${reservationId}`).catch((error: unknown) =>
          console.warn("[organization-drive] native upload cleanup failed", error instanceof Error ? error.name : "UnknownError"));
      }
      try { direct.close(); }
      catch (error: unknown) { console.warn("[organization-drive] native session close failed", error instanceof Error ? error.name : "UnknownError"); }
      if (controller === operation) controller = null;
      active = false;
    }
  }

  async function download(input: z.infer<typeof DownloadRequestSchema>): Promise<DownloadResult> {
    const parsed = DownloadRequestSchema.safeParse(input);
    if (!parsed.success) return { status: "error", code: "unavailable" };
    if (active) return { status: "error", code: "conflict" };
    const status = deps.auth.getStatus();
    const token = deps.auth.getToken();
    const origin = deps.auth.getGatewayOrigin();
    const current = () => {
      const live = deps.auth.getStatus();
      return live.signedIn && live.runtimeSlot === parsed.data.runtimeSlot
        && live.authGeneration === parsed.data.authGeneration && live.userId === status.userId
        && deps.auth.getToken() === token && deps.auth.getGatewayOrigin() === origin;
    };
    if (!token || !current()) return { status: "cancelled" };
    let direct: ReturnType<typeof makeDirect>;
    try { direct = makeDirect({ origin, token }); }
    catch (error: unknown) {
      console.warn("[organization-drive] native session unavailable", error instanceof Error ? error.name : "UnknownError");
      return { status: "error", code: "unavailable" };
    }
    active = true;
    const operation = new AbortController();
    controller = operation;
    try {
      const scope = CollaborationScopeSchema.parse(await direct.request(parsed.data.scopeId, "GET",
        `/api/collaboration/scopes/${parsed.data.scopeId}`));
      if (scope.kind !== "folder" || scope.organizationId !== parsed.data.organizationId || !scope.capabilities.read) {
        return { status: "error", code: "unavailable" };
      }
      const result = OrganizationDriveDownloadSchema.parse(await direct.request(parsed.data.scopeId, "GET",
        `${driveBasePath(parsed.data.scopeId)}/files/${parsed.data.fileId}`));
      if (operation.signal.aborted || !current()) return { status: "cancelled" };
      if (result.file.id !== parsed.data.fileId || result.file.organizationId !== parsed.data.organizationId
        || result.file.size > MAX_FILE_BYTES) return { status: "error", code: "unavailable" };
      await (deps.validateTransferUrl ?? validateDriveTransferUrl)(result.getUrl);
      const response = await (deps.fetchFn ?? fetch)(result.getUrl, { redirect: "error",
        signal: AbortSignal.any([operation.signal, AbortSignal.timeout(5 * 60_000)]) });
      if (!response.ok || !response.body) return { status: "error", code: "unavailable" };
      const reader = response.body.getReader();
      const bytes = new Uint8Array(result.file.size);
      const digest = createHash("sha256");
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          const next = size + part.value.byteLength;
          if (operation.signal.aborted || !current()) return { status: "cancelled" };
          if (next > result.file.size) return { status: "error", code: "unavailable" };
          bytes.set(part.value, size);
          digest.update(part.value);
          size = next;
        }
      } finally {
        await reader.cancel().catch((error: unknown) =>
          console.warn("[organization-drive] download stream cleanup failed", error instanceof Error ? error.name : "UnknownError"));
        reader.releaseLock();
      }
      if (size !== result.file.size) return { status: "error", code: "unavailable" };
      if (digest.digest("hex") !== result.file.sha256) {
        return { status: "error", code: "unavailable" };
      }
      const destination = await deps.chooseDownload(result.file.path.split("/").at(-1) ?? "download");
      if (!current() || operation.signal.aborted) return { status: "cancelled" };
      if (!destination) return { status: "cancelled" };
      if (!deps.saveDownload) return { status: "error", code: "unavailable" };
      await deps.saveDownload(destination, bytes, () => current() && !operation.signal.aborted);
      if (!current() || operation.signal.aborted) return { status: "cancelled" };
      return { status: "downloaded" };
    } catch (error: unknown) {
      if (operation.signal.aborted || !current()) return { status: "cancelled" };
      console.warn("[organization-drive] native download failed", error instanceof Error ? error.name : "UnknownError");
      return { status: "error", code: "unavailable" };
    } finally {
      try { direct.close(); }
      catch (error: unknown) { console.warn("[organization-drive] native session close failed", error instanceof Error ? error.name : "UnknownError"); }
      if (controller === operation) controller = null;
      active = false;
    }
  }

  return { upload, download, cancelAll() { controller?.abort(); } };
}
