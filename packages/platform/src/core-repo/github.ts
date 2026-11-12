/**
 * GitHub App client for the Matrix Core repo. Mints a short-lived App JWT,
 * exchanges it for an installation token per sync, resolves the protected
 * ref, and downloads the commit tarball. Every request has a deadline; the
 * one redirect GitHub uses for tarballs is followed only to codeload, without
 * the token; the body is capped while streaming.
 */
import { createPrivateKey, createSign } from "node:crypto";
import { CORE_REPO_MAX_TARBALL_BYTES, CoreRepoCommitSchema } from "@matrix-os/contracts";
import type { CoreRepoSource } from "./config.js";

const API = "https://api.github.com";
const TARBALL_HOSTS = new Set(["codeload.github.com"]);
const API_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Token and ref responses are tiny; anything larger is refused while streaming. */
const API_RESPONSE_MAX_BYTES = 64 * 1024;

export class CoreRepoUpstreamError extends Error {
  constructor(readonly reason: "token" | "ref" | "download" | "too_large") {
    super("Matrix Core repo upstream failed");
    this.name = "CoreRepoUpstreamError";
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function createGitHubAppJwt(appId: string, privateKey: string, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: appId }))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(createPrivateKey(privateKey));
  return `${unsigned}.${base64url(signature)}`;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new CoreRepoUpstreamError("too_large");
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CoreRepoUpstreamError("too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export function createGitHubCoreRepoClient(options: { appId: string; privateKey: string; fetchImpl?: typeof fetch; now?: () => Date }) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const headers = (token: string) => ({ accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28", "user-agent": "matrix-os-core-repo" });

  async function installationToken(installationId: number): Promise<string> {
    const response = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST", headers: headers(createGitHubAppJwt(options.appId, options.privateKey, now())),
      redirect: "error", signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CoreRepoUpstreamError("token");
    }
    let body: { token?: unknown } | undefined;
    try { body = JSON.parse(new TextDecoder().decode(await readCapped(response, API_RESPONSE_MAX_BYTES))) as { token?: unknown }; }
    catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new CoreRepoUpstreamError("token");
    }
    if (typeof body?.token !== "string" || body.token.length > 1_024) throw new CoreRepoUpstreamError("token");
    return body.token;
  }

  return {
    /** The commit the protected ref points at, plus the token to fetch it with. */
    async headCommit(source: CoreRepoSource): Promise<{ commit: string; token: string }> {
      const token = await installationToken(source.installationId);
      const response = await fetchImpl(`${API}/repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`, {
        headers: { ...headers(token), accept: "application/vnd.github.sha" }, redirect: "error", signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CoreRepoUpstreamError("ref");
      }
      const commit = new TextDecoder().decode(await readCapped(response, API_RESPONSE_MAX_BYTES)).trim();
      const parsed = CoreRepoCommitSchema.safeParse(commit);
      if (!parsed.success) throw new CoreRepoUpstreamError("ref");
      return { commit: parsed.data, token };
    },

    async downloadTarball(source: CoreRepoSource, commit: string, token: string): Promise<Uint8Array> {
      const first = await fetchImpl(`${API}/repos/${source.repository}/tarball/${commit}`, {
        headers: headers(token), redirect: "manual", signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      let response = first;
      if (first.status >= 300 && first.status < 400) {
        await first.body?.cancel();
        const location = first.headers.get("location");
        let target: URL | null = null;
        try { target = location ? new URL(location) : null; }
        catch (error: unknown) { if (!(error instanceof TypeError)) throw error; }
        if (!target || target.protocol !== "https:" || !TARBALL_HOSTS.has(target.hostname)) throw new CoreRepoUpstreamError("download");
        // Codeload URLs are pre-signed; the installation token is never forwarded.
        response = await fetchImpl(target.href, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CoreRepoUpstreamError("download");
      }
      return readCapped(response, CORE_REPO_MAX_TARBALL_BYTES);
    },
  };
}

export type GitHubCoreRepoClient = ReturnType<typeof createGitHubCoreRepoClient>;
