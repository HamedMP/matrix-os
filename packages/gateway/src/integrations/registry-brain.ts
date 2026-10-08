/**
 * Read actions the Company Brain sources call through the Pipedream proxy (specs 558 and 560): GitHub issues and
 * pull requests, Linear issues, comments and project updates, Google Drive folder listings and Doc text, and Google
 * Calendar events. Every action is a read with a strict params schema; values that go into a URL path or a Drive
 * query are checked again where they are used, and every page size has a cap.
 */
import { z } from "zod/v4";
import { listValidation } from "./list-validation.js";
import { cappedPositiveInt, encodeOwnerRepo, linearGraphqlBody } from "./registry-params.js";
import type { ServiceAction } from "./types.js";

// Bounds shared with the existing list actions: owner/name repo, 1..1,000,000 page, 1..100 per page, and an opaque
// provider page token of 1..2048 characters with no space or control character.
const repo = listValidation.issues.shape.repo;
const page = listValidation.issues.shape.page;
const perPage = listValidation.issues.shape.per_page;
const pageToken = listValidation.drive.shape.pageToken;

// GitHub

const GITHUB_NUMBER_MAX = 999_999_999;
const githubNumber = z.number().int().min(1).max(GITHUB_NUMBER_MAX);

// Pull request numbers go into a URL path: positive integers only.
function encodeGithubNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > GITHUB_NUMBER_MAX) {
    throw new Error("number must be a positive integer");
  }
  return String(value);
}

const githubPullListParams = {
  repo: { type: "string", required: true },
  number: { type: "number", required: true },
  page: { type: "number" },
  per_page: { type: "number" },
} as const;

// GitHub API: GET /repos/{owner}/{repo}/pulls/{pull_number}/{commits|reviews|comments}, one capped page.
function githubPullListAction(description: string, suffix: "commits" | "reviews" | "comments"): ServiceAction {
  return {
    description,
    risk: "read",
    paramsSchema: z.strictObject({ repo, number: githubNumber, page, per_page: perPage }),
    params: githubPullListParams,
    directApi: {
      method: "GET",
      url: (p) => `https://api.github.com/repos/${encodeOwnerRepo(p.repo)}/pulls/${encodeGithubNumber(p.number)}/${suffix}`,
      mapParams: (p) => ({
        ...(p.page !== undefined ? { page: String(cappedPositiveInt(p.page, 1, 1_000_000)) } : {}),
        per_page: String(cappedPositiveInt(p.per_page, 100, 100)),
      }),
    },
  };
}

export const BRAIN_GITHUB_ACTIONS: Record<string, ServiceAction> = {
  // GitHub API: GET /repos/{owner}/{repo}/issues with every state, oldest update first. GitHub returns issues and
  // pull requests together; pull requests carry a `pull_request` field.
  list_issues_since: {
    description: "List issues and pull requests updated since a time, oldest update first (use owner/repo format)",
    risk: "read",
    paramsSchema: z.strictObject({ repo, since: z.iso.datetime(), page, per_page: perPage }),
    params: {
      repo: { type: "string", required: true },
      since: { type: "string", required: true },
      page: { type: "number" },
      per_page: { type: "number" },
    },
    directApi: {
      method: "GET",
      url: (p) => `https://api.github.com/repos/${encodeOwnerRepo(p.repo)}/issues`,
      mapParams: (p) => ({
        state: "all",
        sort: "updated",
        direction: "asc",
        since: String(p.since),
        page: String(cappedPositiveInt(p.page, 1, 1_000_000)),
        per_page: String(cappedPositiveInt(p.per_page, 50, 100)),
      }),
    },
  },
  // GitHub API: GET /repos/{owner}/{repo}/pulls/{pull_number} (merge commit, draft, requested reviewers).
  brain_get_pr: {
    description: "Get one pull request (use owner/repo format)",
    risk: "read",
    paramsSchema: z.strictObject({ repo, number: githubNumber }),
    params: {
      repo: { type: "string", required: true },
      number: { type: "number", required: true },
    },
    directApi: {
      method: "GET",
      url: (p) => `https://api.github.com/repos/${encodeOwnerRepo(p.repo)}/pulls/${encodeGithubNumber(p.number)}`,
    },
  },
  brain_list_pr_commits: githubPullListAction(
    "List the commits of a pull request (use owner/repo format)",
    "commits",
  ),
  brain_list_pr_reviews: githubPullListAction(
    "List the reviews of a pull request (use owner/repo format)",
    "reviews",
  ),
  brain_list_pr_review_comments: githubPullListAction(
    "List the review comments of a pull request (use owner/repo format)",
    "comments",
  ),
};

// Linear. Field, argument and filter names checked against Linear's public GraphQL schema
// (github.com/linear/linear, packages/sdk/src/schema.graphql): Query.issues / comments / projectUpdates take
// first, after, includeArchived, orderBy (PaginationOrderBy: createdAt | updatedAt) and filter;
// DateComparator.gte is DateTimeOrDuration; StringComparator.in is [String!]; ProjectFilter.accessibleTeams is a
// TeamCollectionFilter with `some`.

const LINEAR_TEAMS_MAX = 20;
const BrainLinearParams = z.strictObject({
  teamKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/)).min(1).max(LINEAR_TEAMS_MAX),
  updatedSince: z.iso.datetime({ offset: true }),
  first: z.number().int().min(1).max(100).optional(),
  after: z.string().min(1).max(512).nullable().optional(),
});
const brainLinearParamDefs = {
  teamKeys: { type: "array", required: true },
  updatedSince: { type: "string", required: true },
  first: { type: "number" },
  after: { type: "string" },
} as const;

function brainLinearVariables(p: Record<string, unknown>): Record<string, unknown> {
  const teamKeys = Array.isArray(p.teamKeys) ? p.teamKeys.filter((key) => typeof key === "string") : [];
  return {
    teamKeys: teamKeys.slice(0, LINEAR_TEAMS_MAX),
    since: String(p.updatedSince),
    first: cappedPositiveInt(p.first, 50, 100),
    after: typeof p.after === "string" && p.after !== "" ? p.after : null,
  };
}

// One page of `field` for the given teams, updated at or after $since, archived items included so the caller can
// remove them. GraphQL variables carry every caller value; nothing is spliced into the query text.
function brainLinearAction(description: string, operation: string, field: string, filter: string, nodes: string): ServiceAction {
  return {
    description,
    risk: "read",
    paramsSchema: BrainLinearParams,
    params: brainLinearParamDefs,
    directApi: {
      method: "POST",
      url: "https://api.linear.app/graphql",
      mapBody: (p) => linearGraphqlBody(`
        query ${operation}($teamKeys: [String!]!, $since: DateTimeOrDuration!, $first: Int!, $after: String) {
          ${field}(first: $first, after: $after, includeArchived: true, orderBy: updatedAt,
            filter: ${filter}) {
            nodes { ${nodes} }
            pageInfo { hasNextPage endCursor }
          }
        }
      `, brainLinearVariables(p)),
    },
  };
}

export const BRAIN_LINEAR_ACTIONS: Record<string, ServiceAction> = {
  // Twenty labels per issue: the most label refs one brain document keeps.
  brain_issues: brainLinearAction(
    "Company Brain: one page of the teams' issues updated since a time, archived included",
    "MatrixBrainIssues",
    "issues",
    "{ team: { key: { in: $teamKeys } }, updatedAt: { gte: $since } }",
    "id identifier title description url updatedAt dueDate priority archivedAt trashed "
      + "creator { id } assignee { id } state { name type } labels(first: 20) { nodes { name } } project { name }",
  ),
  brain_comments: brainLinearAction(
    "Company Brain: one page of issue comments of the teams updated since a time, archived included",
    "MatrixBrainComments",
    "comments",
    "{ issue: { team: { key: { in: $teamKeys } } }, updatedAt: { gte: $since } }",
    "id body url updatedAt archivedAt user { id } issue { id identifier title }",
  ),
  brain_project_updates: brainLinearAction(
    "Company Brain: one page of project updates of the teams' projects updated since a time, archived included",
    "MatrixBrainProjectUpdates",
    "projectUpdates",
    "{ project: { accessibleTeams: { some: { key: { in: $teamKeys } } } }, updatedAt: { gte: $since } }",
    "id body url updatedAt archivedAt health user { id } project { id name }",
  ),
};

// Google Drive (API v3). Drive ids use letters, digits, `-` and `_` only, so a checked id can sit inside a Drive
// query string literal or a URL path with nothing to escape.

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const driveId = z.string().regex(DRIVE_ID_RE);

function checkedDriveId(value: unknown, name: string): string {
  if (typeof value !== "string" || !DRIVE_ID_RE.test(value)) throw new Error(`${name} must be a Drive id`);
  return value;
}

const DRIVE_LIST_FIELDS = "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,webViewLink,"
  + "lastModifyingUser(emailAddress),capabilities(canDownload))";

export const BRAIN_GOOGLE_DRIVE_ACTIONS: Record<string, ServiceAction> = {
  // Drive API v3: files.list over one folder's direct children that are not trashed, shared drives included.
  brain_list_folder: {
    description: "Company Brain: one page of a folder's files that are not trashed; continue with nextPageToken",
    risk: "read",
    paramsSchema: z.strictObject({
      folderId: driveId,
      pageSize: z.number().int().min(1).max(1000).optional(),
      pageToken,
    }),
    params: {
      folderId: { type: "string", required: true },
      pageSize: { type: "number" },
      pageToken: { type: "string" },
    },
    directApi: {
      method: "GET",
      url: "https://www.googleapis.com/drive/v3/files",
      mapParams: (p) => ({
        q: `'${checkedDriveId(p.folderId, "folderId")}' in parents and trashed = false`,
        fields: DRIVE_LIST_FIELDS,
        pageSize: String(cappedPositiveInt(p.pageSize, 1000, 1000)),
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(p.pageToken !== undefined ? { pageToken: String(p.pageToken) } : {}),
      }),
    },
  },
  // Drive API v3: files.export of a Google Doc as text/plain (Google caps exports at 10 MB).
  brain_export_text: {
    description: "Company Brain: export a Google Doc as plain text",
    risk: "read",
    paramsSchema: z.strictObject({ fileId: driveId }),
    params: { fileId: { type: "string", required: true } },
    directApi: {
      method: "GET",
      url: (p) => `https://www.googleapis.com/drive/v3/files/${checkedDriveId(p.fileId, "fileId")}/export`,
      mapParams: () => ({ mimeType: "text/plain" }),
    },
  },
};
