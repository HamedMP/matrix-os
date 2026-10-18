/**
 * Git source adapter: repository web base and permalinks. Pure functions.
 * A web base is the canonical `https://host/path` of a repository page; it
 * comes either from the source's externalRef (an explicit https base) or from
 * the checkout's origin remote (github.com and gitlab.com only). Credentials,
 * ports and other remote URL parts are never echoed.
 */
import { BRAIN_PERMALINK_MAX_CHARS, BRAIN_SOURCE_EXTERNAL_REF_MAX_CHARS } from "../index.js";
import {
  GIT_REMOTE_URL_MAX_CHARS,
  GitSourceError,
  type GitHostFlavor,
  type GitWebBase,
} from "./types.js";

const SCP_REMOTE_PATTERN = /^(?:[A-Za-z0-9._-]{1,64}@)?([A-Za-z0-9.-]{1,253}):(?!\/)([^\s:]{1,1024})$/;
const REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const WEB_SEGMENT_PATTERN = /^[A-Za-z0-9_.~-]{1,100}$/;
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/;
const REMOTE_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "http:", "ssh:", "git:"]);
const GITLAB_MAX_SEGMENTS = 20;

export type GitWebBaseResolution =
  | { readonly ok: true; readonly webBase: GitWebBase }
  | { readonly ok: false; readonly code: "remote_mismatch" | "web_base_unavailable" };

function knownHostFlavor(host: string): GitHostFlavor | null {
  if (host === "github.com") return "github";
  if (host === "gitlab.com") return "gitlab";
  return null;
}

function locateRemote(input: string): { host: string; path: string } | null {
  if (!input.includes("://")) {
    const match = SCP_REMOTE_PATTERN.exec(input);
    return match ? { host: match[1]!.toLowerCase(), path: match[2]! } : null;
  }
  if (!URL.canParse(input)) return null;
  const url = new URL(input);
  if (!REMOTE_PROTOCOLS.has(url.protocol) || url.search !== "" || url.hash !== "") return null;
  return { host: url.hostname.toLowerCase(), path: url.pathname };
}

function remotePathSegments(rawPath: string): string[] | null {
  let path = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
  if (path.endsWith("/")) path = path.slice(0, -1);
  if (path.endsWith(".git")) path = path.slice(0, -".git".length);
  if (path === "" || path.includes("%")) return null;
  const segments = path.split("/");
  const valid = segments.every((segment) => REMOTE_SEGMENT_PATTERN.test(segment) && !segment.startsWith("."));
  return valid ? segments : null;
}

/**
 * Canonical web base of a github.com or gitlab.com remote (scp, https, http,
 * ssh or git form); null for any other host, a local path, or a malformed
 * remote. Never throws.
 */
export function deriveWebBase(remoteUrl: string): GitWebBase | null {
  const input = remoteUrl.trim();
  if (input === "" || input.length > GIT_REMOTE_URL_MAX_CHARS || WHITESPACE_OR_CONTROL.test(input)) return null;
  const located = locateRemote(input);
  if (located === null) return null;
  const flavor = knownHostFlavor(located.host);
  if (flavor === null) return null;
  const segments = remotePathSegments(located.path);
  if (segments === null) return null;
  const segmentsOk = flavor === "github"
    ? segments.length === 2
    : segments.length >= 2 && segments.length <= GITLAB_MAX_SEGMENTS;
  if (!segmentsOk) return null;
  // A known lowercase host plus [A-Za-z0-9_.-] segments is already canonical (new URL(href).href === href).
  return { href: `https://${located.host}/${segments.join("/")}`, flavor };
}

/**
 * A stored canonical https base (an explicit externalRef): no credentials,
 * query, fragment or trailing slash, exactly as `new URL(value).href`
 * prints it. Returns null for anything else, e.g. an opaque identity.
 */
export function parseWebBase(value: string): GitWebBase | null {
  if (value.length > BRAIN_SOURCE_EXTERNAL_REF_MAX_CHARS || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "" || url.href !== value || value.endsWith("/")) return null;
  if (`${url.origin}${url.pathname}` !== value) return null;
  const segments = url.pathname.slice(1).split("/");
  const valid = segments.every((segment) => WEB_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..");
  if (!valid) return null;
  const host = url.hostname;
  return { href: value, flavor: host === "gitlab.com" || host.startsWith("gitlab.") ? "gitlab" : "github" };
}

function sameRepository(left: GitWebBase, right: GitWebBase): boolean {
  return left.href.toLowerCase() === right.href.toLowerCase();
}

/**
 * The web base for one sync run. An explicit base wins; a derivable remote
 * that names another repository is a mismatch; an underivable remote (an
 * enterprise host, a file path) never mismatches.
 */
export function resolveGitWebBase(input: {
  readonly externalRef: string;
  readonly remoteUrl: string | null;
}): GitWebBaseResolution {
  const explicit = parseWebBase(input.externalRef);
  const derived = input.remoteUrl === null ? null : deriveWebBase(input.remoteUrl);
  if (explicit !== null && derived !== null && !sameRepository(explicit, derived)) {
    return { ok: false, code: "remote_mismatch" };
  }
  const webBase = explicit ?? derived;
  return webBase === null ? { ok: false, code: "web_base_unavailable" } : { ok: true, webBase };
}

function canonicalPermalink(value: string): string | null {
  if (value.length > BRAIN_PERMALINK_MAX_CHARS || !URL.canParse(value)) return null;
  return new URL(value).href === value ? value : null;
}

function requirePermalink(value: string): string {
  const permalink = canonicalPermalink(value);
  if (permalink === null) throw new GitSourceError("web_base_unavailable");
  return permalink;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** GitHub pull request or GitLab merge request page. */
export function pullRequestPermalink(base: GitWebBase, number: number): string {
  const segment = base.flavor === "gitlab" ? "-/merge_requests" : "pull";
  return requirePermalink(`${base.href}/${segment}/${number}`);
}

export function commitPermalink(base: GitWebBase, sha: string): string {
  const segment = base.flavor === "gitlab" ? "-/commit" : "commit";
  return requirePermalink(`${base.href}/${segment}/${sha}`);
}

/** File at a commit; falls back to the commit page when the link would not be canonical or fit. */
export function blobPermalink(base: GitWebBase, sha: string, path: string): string {
  const segment = base.flavor === "gitlab" ? "-/blob" : "blob";
  return canonicalPermalink(`${base.href}/${segment}/${sha}/${encodePath(path)}`) ?? commitPermalink(base, sha);
}
