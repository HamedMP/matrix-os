import { vi } from "vitest";
import { UploadRateLimiter } from "../../packages/pr-evidence-worker/src/bounded.js";
import { GitHubAuthorizer } from "../../packages/pr-evidence-worker/src/github.js";
import { createEvidenceWorker, type EvidenceEnv } from "../../packages/pr-evidence-worker/src/worker.js";

export const TOKEN = "gho_" + "a".repeat(36);
export const SECRET = "s".repeat(48);
export const REPO = "HamedMP/matrix-os";

interface StoredObject {
  bytes: Uint8Array;
  contentType?: string;
}

export class FakeBucket {
  readonly objects = new Map<string, StoredObject>();
  failPut = false;

  async head(key: string) {
    if (this.hideFromHead) return null;
    const stored = this.objects.get(key);
    return stored ? { key, size: stored.bytes.byteLength, httpEtag: `"etag-${key.length}"` } : null;
  }

  async get(key: string, options?: { range?: Headers }) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    let bytes = stored.bytes;
    let range: { offset: number; length: number } | undefined;
    const header = options?.range?.get("range");
    if (header) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(header)!;
      const offset = Number(match[1]);
      const length = Number(match[2]) - offset + 1;
      range = { offset, length };
      bytes = bytes.slice(offset, offset + length);
    }
    return {
      key,
      size: stored.bytes.byteLength,
      httpEtag: `"etag-${key.length}"`,
      range,
      body: new Response(bytes).body,
    };
  }

  hideFromHead = false;

  async put(
    key: string,
    value: ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string }; onlyIf?: Headers },
  ) {
    if (this.failPut) throw new Error("r2 exploded at /internal/path");
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    if (options?.onlyIf?.get("if-none-match") === "*" && this.objects.has(key)) return null;
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    return { key };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

export type GitHubScenario = {
  user?: number | { login: string };
  permission?: number | { permission: string; role_name?: string };
  pull?: number;
  fail?: Error;
};

export function githubFetch(scenario: GitHubScenario = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (scenario.fail) throw scenario.fail;
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) return new Response("{}", { status: 401 });
    const respond = (value: number | object | undefined, fallback: object) =>
      typeof value === "number"
        ? new Response(JSON.stringify({ message: "upstream secret detail" }), { status: value })
        : Response.json(value ?? fallback);
    if (url.endsWith("/user")) return respond(scenario.user, { login: "octo-dev" });
    if (url.includes("/collaborators/")) return respond(scenario.permission, { permission: "write", role_name: "write" });
    if (/\/pulls\/\d+$/.test(url)) return respond(scenario.pull, { number: 1 });
    return new Response("{}", { status: 404 });
  });
}

export function makeWorker(options: { scenario?: GitHubScenario; now?: () => number; limit?: number } = {}) {
  let clock = 1_800_000_000_000;
  const now = options.now ?? (() => clock);
  const fetchImpl = githubFetch(options.scenario);
  const authorizer = new GitHubAuthorizer({ repo: REPO, fetchImpl: fetchImpl as unknown as typeof fetch, now });
  const limiter = new UploadRateLimiter(options.limit ?? 60, 60 * 60 * 1000, now);
  const handle = createEvidenceWorker({ authorizerFor: () => authorizer, limiter, now });
  const bucket = new FakeBucket();
  const env: EvidenceEnv = {
    EVIDENCE: bucket as unknown as R2Bucket,
    UPLOAD_TICKET_SECRET: SECRET,
    GITHUB_REPO: REPO,
    PUBLIC_ORIGIN: "https://evidence.matrix-os.com",
  };
  return {
    handle,
    env,
    bucket,
    fetchImpl,
    advance(ms: number) {
      clock += ms;
    },
  };
}

export function uploadRequest(body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://evidence.matrix-os.com/uploads", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const PNG_FILE = { name: "web-desktop.png", contentType: "image/png", size: 4 };

export function validBody(files: unknown[] = [PNG_FILE]) {
  return { pr: 532, commit: "ABCDEF1234567890", files };
}
