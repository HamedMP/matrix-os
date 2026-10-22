import { createGatewaySpeechClient, SpeechRequestError } from "../lib/speech/client";

interface MockFile {
  name: string;
  written: Uint8Array | null;
  created: unknown;
  deleted: boolean;
}
const mockFiles: MockFile[] = [];
const mockUpload = jest.fn();
const mockDeleteFailure = { next: false };

jest.mock("expo-file-system", () => ({
  UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  Paths: { cache: "file:///cache/" },
  File: class {
    private readonly record: MockFile;
    constructor(_directory: string, name: string) {
      this.record = { name, written: null, created: null, deleted: false };
      mockFiles.push(this.record);
    }
    create(options: unknown) { this.record.created = options; }
    write(bytes: Uint8Array) { this.record.written = Uint8Array.from(bytes); }
    get exists() { return this.record.created !== null && !this.record.deleted; }
    delete() {
      if (mockDeleteFailure.next) {
        mockDeleteFailure.next = false;
        throw new Error("cache cleanup failed");
      }
      this.record.deleted = true;
    }
    upload(...args: unknown[]) { return mockUpload(...args); }
  },
}));

const REQUEST_ID = "sp_1789000000000_abcdefghijklmnop";
const SESSION = { token: "clerk-token", gatewayUrl: "https://app.matrix-os.com/vm/alice" };
const READY = {
  contractVersion: 1,
  fileTranscription: {
    status: "ready",
    dictation: {
      enabled: true,
      maxBytes: 10 * 1024 * 1024,
      maxDurationMs: 120_000,
      maxTranscriptChars: 32_000,
      supportedMediaTypes: ["audio/wav"],
      languageHints: false,
    },
    ownerAudio: { enabled: false },
  },
};
const TRANSCRIPT = {
  contractVersion: 1,
  requestId: REQUEST_ID,
  status: "succeeded",
  outcome: "transcript",
  text: "hello from the phone",
  audioDurationMs: 1_200,
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: jest.fn(async () => text),
  };
}

function recording(bytes = [1, 2, 3]) {
  const data = Uint8Array.from(bytes);
  return { bytes: data, size: data.byteLength, type: "audio/wav" as const };
}

const fetchMock = jest.fn();

beforeEach(() => {
  mockFiles.length = 0;
  mockUpload.mockReset();
  fetchMock.mockReset();
  mockDeleteFailure.next = false;
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("createGatewaySpeechClient", () => {
  describe("capabilities", () => {
    it("asks the computer's gateway with the account's token", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, READY));
      const client = createGatewaySpeechClient(async () => SESSION);

      await expect(client.capabilities()).resolves.toEqual(READY);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://app.matrix-os.com/vm/alice/api/speech/capabilities");
      expect(init).toMatchObject({
        method: "GET",
        headers: { Authorization: "Bearer clerk-token", Accept: "application/json" },
      });
      expect(init.signal).toBeDefined();
    });

    it("is unavailable without an account or a computer, and asks nothing", async () => {
      const client = createGatewaySpeechClient(async () => null);

      await expect(client.capabilities()).rejects.toMatchObject({ code: "unavailable", safeMessage: "Speech is unavailable" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("says what the gateway said went wrong, in its own safe words", async () => {
      fetchMock.mockResolvedValue(jsonResponse(429, { error: { code: "rate_limited", message: "Try speech again later" } }));
      const client = createGatewaySpeechClient(async () => SESSION);

      await expect(client.capabilities()).rejects.toMatchObject({ code: "rate_limited", safeMessage: "Try speech again later" });
    });

    it.each([
      ["an error it does not know", jsonResponse(500, { error: { code: "boom", message: "Postgres: relation missing" } })],
      ["a body that is not JSON", jsonResponse(502, "<html>Bad gateway</html>")],
      ["an answer that is not the capabilities", jsonResponse(200, { ok: true })],
      ["an answer longer than any it sends", jsonResponse(200, READY, { "content-length": String(1024 * 1024) })],
      ["an answer longer than it said", jsonResponse(200, `${JSON.stringify(READY)}${" ".repeat(300 * 1024)}`)],
    ])("turns %s into a plain 'unavailable'", async (_name, response) => {
      fetchMock.mockResolvedValue(response);
      const client = createGatewaySpeechClient(async () => SESSION);

      const failure = client.capabilities();

      await expect(failure).rejects.toBeInstanceOf(SpeechRequestError);
      await expect(failure).rejects.toMatchObject({ code: "unavailable", safeMessage: "Speech is unavailable" });
    });

    it("is unavailable when the network fails, without passing its words on", async () => {
      fetchMock.mockRejectedValue(new TypeError("Network request failed: secret host"));
      const client = createGatewaySpeechClient(async () => SESSION);

      await expect(client.capabilities()).rejects.toMatchObject({ code: "unavailable", safeMessage: "Speech is unavailable" });
    });

    it("does not ask once the caller has given up", async () => {
      let answer!: (session: typeof SESSION) => void;
      const client = createGatewaySpeechClient(() => new Promise((resolve) => { answer = resolve; }));
      const controller = new AbortController();

      const pending = client.capabilities(controller.signal);
      controller.abort();
      answer(SESSION);

      await expect(pending).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("gives up on the request when the caller does", async () => {
      fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
      const client = createGatewaySpeechClient(async () => SESSION);
      const controller = new AbortController();

      const pending = client.capabilities(controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();

      await expect(pending).rejects.toThrow();
    });

    it("gives up after ten seconds", async () => {
      // Hermes may have no AbortSignal.timeout; the timer it falls back to is the one faked here.
      const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
      Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true, writable: true });
      jest.useFakeTimers();
      try {
        fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }));
        const client = createGatewaySpeechClient(async () => SESSION);

        const pending = client.capabilities();
        const settled = expect(pending).rejects.toMatchObject({ code: "unavailable" });
        await jest.advanceTimersByTimeAsync(9_999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        await settled;
      } finally {
        jest.useRealTimers();
        if (timeout) Object.defineProperty(AbortSignal, "timeout", timeout);
      }
    });
  });

  describe("transcribe", () => {
    it("sends the recording as a WAV form field with its request id, and answers with the transcript", async () => {
      mockUpload.mockResolvedValue({ status: 200, body: JSON.stringify(TRANSCRIPT) });
      const client = createGatewaySpeechClient(async () => SESSION);
      const signal = new AbortController().signal;

      await expect(client.transcribe({ requestId: REQUEST_ID, recording: recording(), signal })).resolves.toEqual(TRANSCRIPT);

      expect(mockFiles).toHaveLength(1);
      expect(mockFiles[0]).toMatchObject({ name: `speech-${REQUEST_ID}.wav`, created: { overwrite: false } });
      expect(Array.from(mockFiles[0]!.written!)).toEqual([1, 2, 3]);
      const [url, options] = mockUpload.mock.calls[0]!;
      expect(url).toBe("https://app.matrix-os.com/vm/alice/api/speech/transcriptions");
      expect(options).toMatchObject({
        httpMethod: "POST",
        uploadType: 1,
        fieldName: "recording",
        mimeType: "audio/wav",
        parameters: { requestId: REQUEST_ID },
        headers: { Authorization: "Bearer clerk-token", Accept: "application/json" },
        sessionType: "foreground",
      });
      expect(options.signal).toBeDefined();
    });

    it("answers 'no speech' when nothing was said", async () => {
      const noSpeech = { contractVersion: 1, requestId: REQUEST_ID, status: "succeeded", outcome: "no_speech", audioDurationMs: 900 };
      mockUpload.mockResolvedValue({ status: 200, body: JSON.stringify(noSpeech) });
      const client = createGatewaySpeechClient(async () => SESSION);

      await expect(client.transcribe({ requestId: REQUEST_ID, recording: recording(), signal: new AbortController().signal }))
        .resolves.toEqual(noSpeech);
    });

    it("removes the recording from the phone and blanks it in memory once sent", async () => {
      mockUpload.mockResolvedValue({ status: 200, body: JSON.stringify(TRANSCRIPT) });
      const client = createGatewaySpeechClient(async () => SESSION);
      const sent = recording();

      await client.transcribe({ requestId: REQUEST_ID, recording: sent, signal: new AbortController().signal });

      expect(mockFiles[0]!.deleted).toBe(true);
      expect(Array.from(sent.bytes)).toEqual([0, 0, 0]);
    });

    it("removes the recording when sending fails too", async () => {
      mockUpload.mockRejectedValue(new Error("connection reset by provider"));
      const client = createGatewaySpeechClient(async () => SESSION);
      const sent = recording();

      await expect(client.transcribe({ requestId: REQUEST_ID, recording: sent, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: "unavailable", safeMessage: "Speech is unavailable" });
      expect(mockFiles[0]!.deleted).toBe(true);
      expect(Array.from(sent.bytes)).toEqual([0, 0, 0]);
    });

    it("keeps a transcript when removing the file fails", async () => {
      mockUpload.mockResolvedValue({ status: 200, body: JSON.stringify(TRANSCRIPT) });
      mockDeleteFailure.next = true;
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const client = createGatewaySpeechClient(async () => SESSION);

      await expect(client.transcribe({ requestId: REQUEST_ID, recording: recording(), signal: new AbortController().signal }))
        .resolves.toEqual(TRANSCRIPT);
      expect(warn).toHaveBeenCalledWith("[speech] recording file cleanup failed", "Error");
      warn.mockRestore();
    });

    it.each([
      [402, "allowance_exhausted", "Speech allowance is unavailable"],
      [422, "invalid_media", "This recording cannot be transcribed"],
      [504, "timeout", "Transcription timed out"],
    ])("says why a %i refusal happened", async (status, code, message) => {
      mockUpload.mockResolvedValue({ status, body: JSON.stringify({ error: { code, message } }) });
      const client = createGatewaySpeechClient(async () => SESSION);

      await expect(client.transcribe({ requestId: REQUEST_ID, recording: recording(), signal: new AbortController().signal }))
        .rejects.toMatchObject({ code, safeMessage: message });
    });

    it("does not take a transcript for another request", async () => {
      const other = { ...TRANSCRIPT, requestId: "sp_1789000000000_zyxwvutsrqponmlk" };
      mockUpload.mockResolvedValue({ status: 200, body: JSON.stringify(other) });
      const client = createGatewaySpeechClient(async () => SESSION);

      await expect(client.transcribe({ requestId: REQUEST_ID, recording: recording(), signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: "unavailable" });
    });

    it("does not read an answer longer than any it sends", async () => {
      mockUpload.mockResolvedValue({ status: 200, body: " ".repeat(300 * 1024) });
      const client = createGatewaySpeechClient(async () => SESSION);

      await expect(client.transcribe({ requestId: REQUEST_ID, recording: recording(), signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: "unavailable" });
    });

    it("refuses a request id that is not one", async () => {
      const client = createGatewaySpeechClient(async () => SESSION);

      await expect(client.transcribe({ requestId: "../../etc", recording: recording(), signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: "invalid_request" });
      expect(mockFiles).toHaveLength(0);
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it("writes nothing when it was cancelled before it began", async () => {
      const client = createGatewaySpeechClient(async () => SESSION);
      const controller = new AbortController();
      controller.abort();

      await expect(client.transcribe({ requestId: REQUEST_ID, recording: recording(), signal: controller.signal })).rejects.toThrow();
      expect(mockFiles).toHaveLength(0);
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it("stops the upload when the caller cancels, and still removes the file", async () => {
      mockUpload.mockImplementation((_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
      const client = createGatewaySpeechClient(async () => SESSION);
      const controller = new AbortController();

      const pending = client.transcribe({ requestId: REQUEST_ID, recording: recording(), signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();

      await expect(pending).rejects.toThrow();
      expect(mockFiles[0]!.deleted).toBe(true);
    });
  });

  describe("cancel", () => {
    it("asks the gateway to drop the request", async () => {
      const cancelled = {
        contractVersion: 1,
        requestId: REQUEST_ID,
        cancellationRequested: true,
        executionState: "cancelled",
        executionStarted: false,
      };
      fetchMock.mockResolvedValue(jsonResponse(200, cancelled));
      const client = createGatewaySpeechClient(async () => SESSION);

      await client.cancel(REQUEST_ID);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`https://app.matrix-os.com/vm/alice/api/speech/transcriptions/${REQUEST_ID}`);
      expect(init).toMatchObject({ method: "DELETE", headers: { Authorization: "Bearer clerk-token" } });
    });
  });
});
