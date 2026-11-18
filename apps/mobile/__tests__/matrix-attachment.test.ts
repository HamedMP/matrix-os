import { MAX_AGENT_ATTACHMENT_BYTES } from "@matrix-os/contracts";
import { stageMatrixAttachment } from "../lib/matrix-attachment";

const mockFetch = jest.fn();
const mockWrite = jest.fn();
const mockCreate = jest.fn();
jest.mock("expo/fetch", () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock("expo-crypto", () => ({ getRandomValues: (bytes: Uint8Array) => bytes }));
jest.mock("expo-file-system", () => ({
  Paths: { cache: "file:///fixture-cache/" },
  Directory: class {
    create() {}
    list() { return []; }
  },
  File: class {
    uri = "file:///fixture-cache/attachment";
    create(options: unknown) { mockCreate(options); }
    write(bytes: Uint8Array) { mockWrite(bytes); }
  },
}));

const source = { gatewayUrl: "https://matrix.test/vm/owner/~runtime/review", userId: "fixture-owner", path: "reports/Space file.txt" };
function reply(values: Uint8Array[], headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" }) {
  const reader = {
    read: jest.fn(async () => values.length ? { done: false, value: values.shift() } : { done: true }),
    releaseLock: jest.fn(),
  };
  const body = { getReader: () => reader, cancel: jest.fn() };
  mockFetch.mockResolvedValue({ ok: true, headers: { get: (name: string) => headers[name] ?? null }, body });
  return { body, reader };
}

beforeEach(() => jest.clearAllMocks());

it("reads the selected computer with the current token and stages the original bytes for the existing upload queue", async () => {
  const { reader } = reply([new Uint8Array([1, 22]), new Uint8Array([3])]);
  const result = await stageMatrixAttachment(source, "fixture-token", ["file"], new AbortController().signal);
  expect(mockFetch).toHaveBeenCalledWith(
    "https://matrix.test/vm/owner/~runtime/review/api/file-previews/content?kind=home&path=reports%2FSpace+file.txt&download=true",
    expect.objectContaining({ headers: { Authorization: "Bearer fixture-token" }, redirect: "error" }),
  );
  expect(mockCreate).toHaveBeenCalledWith({ overwrite: false });
  expect(mockWrite).toHaveBeenCalledWith(new Uint8Array([1, 22, 3]));
  expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ matrixSource: source, name: "Space file.txt", mimeType: "text/plain", sizeBytes: 3 });
});

it.each([
  [{ "content-type": "text/plain", "content-length": String(MAX_AGENT_ATTACHMENT_BYTES + 1) }, ["file"], "MatrixAttachmentTooLarge"],
  [{ "content-type": "image/png" }, ["file"], "MatrixAttachmentUnsupported"],
] as const)("rejects unsafe size or unsupported model inputs before staging", async (headers, kinds, reason) => {
  const { body, reader } = reply([], headers);
  await expect(stageMatrixAttachment(source, "fixture-token", kinds, new AbortController().signal)).rejects.toThrow(reason);
  expect(body.cancel).toHaveBeenCalledTimes(1);
  expect(reader.read).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

it("does not stage a late read after its draft was abandoned", async () => {
  reply([new Uint8Array([1])]);
  const request = new AbortController();
  const result = stageMatrixAttachment(source, "fixture-token", ["file"], request.signal);
  request.abort();
  await expect(result).rejects.toThrow("MatrixAttachmentUnavailable");
  expect(mockCreate).not.toHaveBeenCalled();
});
