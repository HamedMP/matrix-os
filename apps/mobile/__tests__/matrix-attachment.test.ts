import { MAX_AGENT_ATTACHMENT_BYTES } from "@matrix-os/contracts";
import { discardMatrixAttachment, stageMatrixAttachment } from "../lib/matrix-attachment";
import { forgetStagedMatrixAttachment, retainMatrixAttachmentUris } from "../lib/matrix-attachment-retention";

const mockFetch = jest.fn();
const mockWrite = jest.fn();
const mockCreate = jest.fn();
const mockFiles: { uri: string; lastModified: number; delete: () => void }[] = [];
let mockRandom = 0;
jest.mock("expo/fetch", () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock("expo-crypto", () => ({ getRandomValues: (bytes: Uint8Array) => bytes.fill(++mockRandom) }));
jest.mock("expo-file-system", () => ({
  Paths: { cache: "file:///fixture-cache/" },
  Directory: class {
    create() {}
    list() { return mockFiles; }
  },
  File: class {
    uri: string;
    lastModified = Date.now();
    exists = false;
    constructor(_directory: unknown, ...names: string[]) { this.uri = `file:///fixture-cache/chat-matrix-attachments/${names.at(-1)}`; }
    create(options: unknown) { mockCreate(options); this.exists = true; mockFiles.push(this); }
    write(bytes: Uint8Array) { mockWrite(bytes); }
    delete() { this.exists = false; const index = mockFiles.indexOf(this); if (index >= 0) mockFiles.splice(index, 1); }
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

beforeEach(() => { jest.clearAllMocks(); mockFiles.splice(0); });
afterEach(() => { mockFiles.forEach((file) => forgetStagedMatrixAttachment(file.uri)); });

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

it("keeps the original cached bytes of a retained draft or failed send after 24 hours, then collects them after release", async () => {
  reply([new Uint8Array([42])]);
  const first = await stageMatrixAttachment(source, "fixture-token", ["file"], new AbortController().signal);
  const release = retainMatrixAttachmentUris([first.uri]);
  const original = mockFiles.find((file) => file.uri === first.uri)!;
  original.lastModified = Date.now() - 25 * 60 * 60 * 1000;
  try {
    reply([new Uint8Array([7])]);
    await stageMatrixAttachment({ ...source, path: "another.txt" }, "fixture-token", ["file"], new AbortController().signal);
    expect(mockFiles).toContain(original);
  } finally { release(); }
  reply([new Uint8Array([9])]);
  await stageMatrixAttachment({ ...source, path: "last.txt" }, "fixture-token", ["file"], new AbortController().signal);
  expect(mockFiles).not.toContain(original);
});

it("bounds cache protection and fails a new selection without deleting files still in use", async () => {
  const attachments = [];
  const releases: (() => void)[] = [];
  try {
    for (let index = 0; index < 64; index++) {
      reply([new Uint8Array([index])]);
      const attachment = await stageMatrixAttachment({ ...source, path: `${index}.txt` }, "fixture-token", ["file"], new AbortController().signal);
      attachments.push(attachment);
      releases.push(retainMatrixAttachmentUris([attachment.uri]));
    }
    reply([new Uint8Array([1])]);
    await expect(stageMatrixAttachment(source, "fixture-token", ["file"], new AbortController().signal)).rejects.toThrow("MatrixAttachmentCacheFull");
    expect(mockFiles).toHaveLength(64);
  } finally {
    releases.forEach((release) => release());
    attachments.forEach(discardMatrixAttachment);
  }
});
