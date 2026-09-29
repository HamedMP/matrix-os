import { describe, expect, it, vi } from "vitest";
import { createOrganizationDriveTransferService } from "../../desktop/src/main/files/organization-drive-transfer";

const scopeId = "00000000-0000-4000-8000-000000000001";
const organizationId = "org_example";
const uploadId = "00000000-0000-4000-8000-000000000002";
const fileId = "00000000-0000-4000-8000-000000000003";
const bytes = new TextEncoder().encode("example");
const sha256 = "50d858e0985ecc7f60418aaf0cc5ab587f42c2570a884095a9e8ccacd0f6545c";

function fixture() {
  const state = { signedIn: true, runtimeSlot: "primary", authGeneration: 3,
    userId: "user_member", platformHost: "https://app.matrix-os.com" };
  const auth = { getToken: vi.fn(() => "test-token"), getGatewayOrigin: vi.fn(() => state.platformHost),
    getStatus: vi.fn(() => state) };
  const request = vi.fn(async (_scope: string, method: string, path: string): Promise<unknown> => {
    if (method === "GET" && path.endsWith(`/scopes/${scopeId}`)) return { id: scopeId, ownerId: "user_owner",
      organizationId, kind: "folder", resourceId: "folder_example", membershipMode: "direct",
      lifecycle: "shared", revision: "1", authEpoch: "1", authorityGeneration: "1", role: "editor",
      capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false } };
    if (method === "POST" && path.endsWith("/files/lookup")) return { baseVersion: 0 };
    if (method === "POST" && path.endsWith("/uploads")) return { uploadId,
      putUrl: "https://example.r2.cloudflarestorage.com/upload", expiresAt: "2026-09-29T23:00:00.000Z" };
    if (method === "POST" && path.endsWith(`/uploads/${uploadId}/commit`)) return { id: fileId,
      organizationId, path: "example.txt", version: 1, size: bytes.length, sha256,
      updatedBy: "user_member", updatedAt: "2026-09-29T22:00:00.000Z" };
    if (method === "GET" && path.endsWith(`/files/${fileId}`)) return { file: { id: fileId,
      organizationId, path: "example.txt", version: 1, size: bytes.length, sha256,
      updatedBy: "user_member", updatedAt: "2026-09-29T22:00:00.000Z" },
      getUrl: "https://example.r2.cloudflarestorage.com/download" };
    if (method === "DELETE" && path.endsWith(`/uploads/${uploadId}`)) return undefined;
    throw new Error(`Unexpected ${method} ${path}`);
  });
  const close = vi.fn();
  const directFactory = vi.fn(() => ({ request, close }));
  const chooseUpload = vi.fn(async () => ({ name: "example.txt", bytes }));
  const chooseDownload = vi.fn(async () => "/tmp/example.txt");
  const saveDownload = vi.fn(async () => undefined);
  const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
  const service = createOrganizationDriveTransferService({ auth, directFactory,
    chooseUpload, chooseDownload, saveDownload, fetchFn, validateTransferUrl: vi.fn(async () => undefined) });
  return { state, auth, request, close, directFactory, chooseUpload, chooseDownload, saveDownload, fetchFn, service };
}

describe("Electron organization drive transfer", () => {
  it("uses trusted auth to reserve and commit an uploaded file", async () => {
    const fx = fixture();
    const result = await fx.service.upload({ scopeId, organizationId, folder: "", runtimeSlot: "primary", authGeneration: 3 });
    expect(result).toEqual({ status: "uploaded", fileId });
    expect(fx.request).toHaveBeenCalledWith(scopeId, "POST", expect.stringMatching(/\/uploads$/),
      expect.objectContaining({ path: "example.txt", size: bytes.length, sha256, baseVersion: 0 }));
    expect(fx.fetchFn).toHaveBeenCalledWith("https://example.r2.cloudflarestorage.com/upload",
      expect.objectContaining({ method: "PUT", body: expect.any(Uint8Array), redirect: "error" }));
    expect(fx.fetchFn.mock.calls[0]?.[1]?.body).toEqual(bytes);
    expect(fx.close).toHaveBeenCalled();
  });

  it("rejects an obsolete auth generation before opening a picker or session", async () => {
    const fx = fixture();
    const result = await fx.service.upload({ scopeId, organizationId, folder: "", runtimeSlot: "primary", authGeneration: 2 });
    expect(result).toEqual({ status: "cancelled" });
    expect(fx.chooseUpload).not.toHaveBeenCalled();
    expect(fx.directFactory).not.toHaveBeenCalled();
  });

  it("stops when the account changes while the native file picker is open", async () => {
    const fx = fixture();
    fx.chooseUpload.mockImplementationOnce(async () => {
      fx.state.authGeneration = 4;
      return { name: "example.txt", bytes };
    });
    const result = await fx.service.upload({ scopeId, organizationId, folder: "", runtimeSlot: "primary", authGeneration: 3 });
    expect(result).toEqual({ status: "cancelled" });
    expect(fx.request).not.toHaveBeenCalledWith(scopeId, "POST", expect.stringMatching(/\/uploads$/), expect.anything());
  });

  it("does not open the file picker for a viewer", async () => {
    const fx = fixture();
    fx.request.mockResolvedValueOnce({ id: scopeId, ownerId: "user_owner", organizationId,
      kind: "folder", resourceId: "folder_example", membershipMode: "direct", lifecycle: "shared",
      revision: "1", authEpoch: "1", authorityGeneration: "1", role: "viewer",
      capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false } });
    const result = await fx.service.upload({ scopeId, organizationId, folder: "", runtimeSlot: "primary", authGeneration: 3 });
    expect(result).toEqual({ status: "error", code: "unavailable" });
    expect(fx.chooseUpload).not.toHaveBeenCalled();
  });

  it("aborts an active R2 upload and cleans its reservation", async () => {
    const fx = fixture();
    let entered!: () => void;
    const reachedPut = new Promise<void>((resolve) => { entered = resolve; });
    fx.fetchFn.mockImplementationOnce((...args: unknown[]) => {
      const signal = (args[1] as RequestInit).signal!;
      entered();
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")), { once: true }));
    });
    const pending = fx.service.upload({ scopeId, organizationId, folder: "", runtimeSlot: "primary", authGeneration: 3 });
    await reachedPut;
    fx.service.cancelAll();
    expect(await pending).toEqual({ status: "cancelled" });
    expect(fx.request).toHaveBeenCalledWith(scopeId, "DELETE", expect.stringMatching(/\/uploads\//));
  });

  it("verifies download bytes before asking for a destination", async () => {
    const fx = fixture();
    fx.fetchFn.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const result = await fx.service.download({ scopeId, organizationId, fileId,
      runtimeSlot: "primary", authGeneration: 3 });
    expect(result).toEqual({ status: "downloaded" });
    expect(fx.chooseDownload).toHaveBeenCalledWith("example.txt");
    expect(fx.saveDownload).toHaveBeenCalledWith("/tmp/example.txt", bytes);
  });

  it("rejects a changed download before writing a local file", async () => {
    const fx = fixture();
    fx.fetchFn.mockResolvedValueOnce(new Response("tamper!", { status: 200 }));
    const result = await fx.service.download({ scopeId, organizationId, fileId,
      runtimeSlot: "primary", authGeneration: 3 });
    expect(result).toEqual({ status: "error", code: "unavailable" });
    expect(fx.chooseDownload).not.toHaveBeenCalled();
    expect(fx.saveDownload).not.toHaveBeenCalled();
  });
});
