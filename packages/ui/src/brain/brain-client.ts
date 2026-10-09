import {
  BRAIN_ERROR_COPY,
  type BrainProjectOption,
  type BrainShellClient,
  type BrainShellErrorState,
} from "./brain-types.js";

export interface BrainRequestOptions { readonly timeoutMs?: number }

/**
 * What the view needs from a renderer: four JSON calls to the gateway with a per-call timeout. The renderer adds the
 * session. A failed call rejects with an Error that has `category` ("unauthorized", "offline", "timeout", "notFound"
 * or "server") and may have `detail`, a lower_snake gateway code; anything else reads as "unavailable".
 */
export interface BrainHttpTransport {
  get<T>(path: string, options?: BrainRequestOptions): Promise<T>;
  post<T>(path: string, body: unknown, options?: BrainRequestOptions): Promise<T>;
  patch<T>(path: string, body: unknown, options?: BrainRequestOptions): Promise<T>;
  delete<T>(path: string, options?: BrainRequestOptions): Promise<T>;
}

type BrainRequestCategory = "unauthorized" | "offline" | "timeout" | "notFound" | "server";
const REQUEST_CATEGORIES: readonly BrainRequestCategory[] = ["unauthorized", "offline", "timeout", "notFound", "server"];
const CODE_PATTERN = /^[a-z][a-z0-9_]{2,48}$/;

/** The category and code of a failed transport call, read by shape; null for any other error. */
function brainRequestFailure(error: unknown): { readonly category: BrainRequestCategory; readonly detail: string } | null {
  if (!(error instanceof Error)) return null;
  const { category, detail } = error as { readonly category?: unknown; readonly detail?: unknown };
  const known = REQUEST_CATEGORIES.find((candidate) => candidate === category);
  if (known === undefined) return null;
  return { category: known, detail: typeof detail === "string" && CODE_PATTERN.test(detail) ? detail : "" };
}

/** Reads answer quickly; sync, rules extract, refresh, brief builds and impact run one bounded server job (20 s budget). */
export const BRAIN_READ_TIMEOUT_MS = 15_000;
export const BRAIN_RUN_TIMEOUT_MS = 45_000;
/**
 * A model extract may run 120 s plus one 60 s model call (spec 555). Today the proxies in front of the gateway end any
 * request at 30 s (Next's default proxyTimeout on Web, the platform's PROXY_TIMEOUT_MS on every surface), so the
 * Sources screen words that failure as a run that may still be finishing; this wait applies once that path allows
 * long runs (spec 563, Failure modes).
 */
export const BRAIN_MODEL_RUN_TIMEOUT_MS = 190_000;
export const BRAIN_PROJECTS_MAX = 200;
const PROJECT_ID_PATTERN = /^proj_[A-Za-z0-9_-]{1,128}$/;
const PROJECT_NAME_MAX_CHARS = 120;

type QueryValue = string | number | readonly string[] | null | undefined;

/**
 * Builds a query string from the defined values only (the routes refuse unknown or empty keys); lists travel as one
 * comma-separated value, as the gateway expects.
 */
export function brainQuery(values: Readonly<Record<string, QueryValue>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") {
      if (value.length > 0) params.set(key, value.join(","));
      continue;
    }
    params.set(key, String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

function projectPath(projectId: string): string {
  return `/api/brain/projects/${encodeURIComponent(projectId)}`;
}

const id = encodeURIComponent;

/** BrainShellClient over a renderer's gateway transport: one method per /api/brain route. */
export function createBrainShellApi(client: BrainHttpTransport): BrainShellClient {
  function read<T>(projectId: string, path: string, query: Readonly<Record<string, QueryValue>> = {},
    timeoutMs = BRAIN_READ_TIMEOUT_MS): Promise<T> {
    return client.get<T>(`${projectPath(projectId)}${path}${brainQuery(query)}`, { timeoutMs });
  }
  function run<T>(projectId: string, path: string, body: unknown, timeoutMs = BRAIN_RUN_TIMEOUT_MS): Promise<T> {
    return client.post<T>(`${projectPath(projectId)}${path}`, body, { timeoutMs });
  }
  return {
    registerGitSource: (projectId, input) => run(projectId, "/git-source", input),
    syncGit: (projectId) => run(projectId, "/sync", {}),
    gitReceipts: (projectId, limit) => read(projectId, "/receipts", { limit }),
    why: (projectId, query) => read(projectId, "/why", {
      path: query.path, limit: query.limit, cursor: query.cursor, detail: query.detail,
    }),
    extract: (projectId, input) => run(projectId, "/extract", input,
      input.extractor === "model" ? BRAIN_MODEL_RUN_TIMEOUT_MS : BRAIN_RUN_TIMEOUT_MS),
    claims: (projectId, query) => read(projectId, "/claims", {
      kind: query.kind, path: query.path, limit: query.limit, cursor: query.cursor,
    }),
    search: (projectId, query) => read(projectId, "/search", {
      q: query.q, types: query.types, kinds: query.kinds, claimKinds: query.claimKinds, source: query.sourceId,
      from: query.from, to: query.to, path: query.path, mode: query.mode, limit: query.limit, cursor: query.cursor,
    }),
    refreshSearch: (projectId) => run(projectId, "/search/refresh", {}),
    timeline: (projectId, query) => read(projectId, "/timeline", {
      entity: query.entity, linkTypes: query.linkTypes, from: query.from, to: query.to, limit: query.limit,
      cursor: query.cursor,
    }),
    entities: (projectId, query) => read(projectId, "/entities", {
      kind: query.kind, q: query.q, limit: query.limit, cursor: query.cursor,
    }),
    entity: (projectId, entityId) => read(projectId, `/entities/${id(entityId)}`),
    entityLinks: (projectId, entityId, query) => read(projectId, `/entities/${id(entityId)}/links`, {
      hops: query.hops, types: query.types, direction: query.direction, limit: query.limit, cursor: query.cursor,
    }),
    updateAlias: (projectId, entityId, input) => run(projectId, `/entities/${id(entityId)}/aliases`, input),
    mergeSuggestions: (projectId, query) => read(projectId, "/entities/merge-suggestions", {
      limit: query.limit, cursor: query.cursor,
    }),
    refreshGraph: (projectId) => run(projectId, "/graph/refresh", {}),
    sources: (projectId) => read(projectId, "/sources"),
    connectSource: (projectId, input) => run(projectId, "/sources", input),
    sourceOptions: (projectId, kind, query) => read(projectId, "/sources/options", {
      kind, q: query.q, cursor: query.cursor,
    }),
    updateSource: (projectId, sourceId, input) =>
      client.patch(`${projectPath(projectId)}/sources/${id(sourceId)}`, input, { timeoutMs: BRAIN_READ_TIMEOUT_MS }),
    removeSource: (projectId, sourceId, expectedRevision) => client.delete(
      `${projectPath(projectId)}/sources/${id(sourceId)}${brainQuery({ expectedRevision })}`,
      { timeoutMs: BRAIN_READ_TIMEOUT_MS },
    ),
    syncSource: (projectId, sourceId) => run(projectId, `/sources/${id(sourceId)}/sync`, {}),
    sourceReceipts: (projectId, sourceId, limit) => read(projectId, `/sources/${id(sourceId)}/receipts`, { limit }),
    brief: (projectId, query) => read(projectId, "/brief", { date: query.date, window: query.window },
      BRAIN_RUN_TIMEOUT_MS),
    generateBrief: (projectId, input) => run(projectId, "/brief", input),
    conflicts: (projectId, query) => read(projectId, "/conflicts", {
      rules: query.rules, limit: query.limit, cursor: query.cursor,
    }),
    stale: (projectId, query) => read(projectId, "/stale", { kinds: query.kinds, limit: query.limit, cursor: query.cursor }),
    impact: (projectId, query) => read(projectId, "/impact", {
      base: query.base, head: query.head, depth: query.depth,
    }, BRAIN_RUN_TIMEOUT_MS),
    // A job is queued and answered at once (202); the work runs in the gateway.
    startJob: (projectId, input) => run(projectId, "/jobs", input, BRAIN_READ_TIMEOUT_MS),
    job: (projectId, jobId) => read(projectId, `/jobs/${id(jobId)}`),
    jobs: (projectId, limit) => read(projectId, "/jobs", { limit }),
    cancelJob: (projectId, jobId) => run(projectId, `/jobs/${id(jobId)}/cancel`, {}, BRAIN_READ_TIMEOUT_MS),
  };
}

/** A 404 without a known code: this gateway does not serve the route (an older gateway). */
export function brainRouteMissing(error: unknown): boolean {
  const failure = brainRequestFailure(error);
  return failure?.category === "notFound" && !Object.hasOwn(BRAIN_ERROR_COPY, failure.detail);
}

/**
 * Background runs cannot take this one: no jobs route (an older gateway), or no job of that kind on this gateway (no
 * step for it, or no worker runs this owner's jobs). The screens then run the work directly.
 */
export function brainJobsUnavailable(error: unknown): boolean {
  return brainRouteMissing(error) || brainRequestFailure(error)?.detail === "job_kind_unavailable";
}

/**
 * A direct run cut short on its way back may still be going in the gateway: too slow, or a 500 without a known code
 * (a proxy ending the request). A gateway that answered with a code (brain_unavailable included) ran nothing.
 */
export function brainRunMayContinue(error: unknown): boolean {
  const failure = brainRequestFailure(error);
  return failure !== null && (failure.category === "timeout"
    || (failure.category === "server" && !Object.hasOwn(BRAIN_ERROR_COPY, failure.detail)));
}

/**
 * Maps a failed call to what the screens show. Only a known error code is kept (else "unknown"); the server's
 * message is never read. A server error without a known code, or brain_unavailable (503), is "unavailable".
 */
export function brainShellError(error: unknown): BrainShellErrorState {
  const failure = brainRequestFailure(error);
  if (failure === null) {
    console.warn("[brain] request failed", error instanceof Error ? error.name : typeof error);
    return { kind: "unavailable" };
  }
  const code = Object.hasOwn(BRAIN_ERROR_COPY, failure.detail) ? failure.detail : "unknown";
  switch (failure.category) {
    case "unauthorized": return { kind: "unauthorized" };
    case "offline": return { kind: "offline" };
    case "timeout": return { kind: "timeout" };
    case "notFound": return { kind: "not_found", code };
    default: return code === "unknown" || code === "brain_unavailable" ? { kind: "unavailable" } : { kind: "rejected", code };
  }
}

/** The owner's active projects (GET /api/workspace/projects, first page), checked field by field and capped. */
export async function listBrainProjects(client: BrainHttpTransport): Promise<BrainProjectOption[]> {
  const value = await client.get<unknown>("/api/workspace/projects", { timeoutMs: BRAIN_READ_TIMEOUT_MS });
  const list = typeof value === "object" && value !== null ? (value as { projects?: unknown }).projects : undefined;
  if (!Array.isArray(list)) return [];
  return list.slice(0, BRAIN_PROJECTS_MAX).flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id: projectId, name, slug } = entry as Record<string, unknown>;
    if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId) || typeof slug !== "string") return [];
    const label = typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, PROJECT_NAME_MAX_CHARS) : slug;
    return [{ id: projectId, name: label, slug }];
  });
}
