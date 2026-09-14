import { z } from "zod/v4";
import type { ServiceAction } from "./types.js";

const text = z.string().min(1).max(256);
const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const page = z.number().int().min(1).max(50);

// Version 1: fixed documents only. Never interpolate caller input into GraphQL.
export const SYMPHONY_LINEAR_ACTIONS: Record<string, ServiceAction> = {
  symphony_poll: {
    description: "Symphony poll",
    risk: "read",
    params: {projectSlug: { type: "string" }, stateNames: { type: "array" }, first: { type: "number" }, relationFirst: { type: "number" }, after: { type: "string" }},
    paramsSchema: z.object({ projectSlug: text, stateNames: z.array(text).min(1).max(50), first: page, relationFirst: page, after: text.nullable().optional() }).strict(),
    directApi: {
      method: "POST",
      url: "https://api.linear.app/graphql",
      mapBody: (params) => ({ query: `
  query SymphonyLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
    issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        description
        priority
        state {
          name
        }
        branchName
        url
        assignee {
          id
        }
        labels {
          nodes {
            name
          }
        }
        inverseRelations(first: $relationFirst) {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`, variables: params }),
    },
  },
  symphony_issues_by_id: {
    description: "Symphony issues by id",
    risk: "read",
    params: {ids: { type: "array" }, first: { type: "number" }, relationFirst: { type: "number" }},
    paramsSchema: z.object({ ids: z.array(id).min(1).max(50), first: page, relationFirst: page }).strict(),
    directApi: {
      method: "POST",
      url: "https://api.linear.app/graphql",
      mapBody: (params) => ({ query: `
  query SymphonyLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
    issues(filter: {id: {in: $ids}}, first: $first) {
      nodes {
        id
        identifier
        title
        description
        priority
        state {
          name
        }
        branchName
        url
        assignee {
          id
        }
        labels {
          nodes {
            name
          }
        }
        inverseRelations(first: $relationFirst) {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
        createdAt
        updatedAt
      }
    }
  }
`, variables: params }),
    },
  },
  symphony_viewer: {
    description: "Symphony viewer",
    risk: "read",
    params: {},
    paramsSchema: z.object({}).strict(),
    directApi: {
      method: "POST",
      url: "https://api.linear.app/graphql",
      mapBody: (params) => ({ query: `
  query SymphonyLinearViewer {
    viewer {
      id
    }
  }
`, variables: params }),
    },
  },
  symphony_create_comment: {
    description: "Symphony create comment",
    risk: "write",
    params: {issueId: { type: "string" }, body: { type: "string" }},
    paramsSchema: z.object({ issueId: id, body: z.string().min(1).max(10000) }).strict(),
    directApi: {
      method: "POST",
      url: "https://api.linear.app/graphql",
      mapBody: (params) => ({ query: `
  mutation SymphonyCreateComment($issueId: String!, $body: String!) {
    commentCreate(input: {issueId: $issueId, body: $body}) {
      success
      comment { id url }
    }
  }
`, variables: params }),
    },
  },
  symphony_resolve_state: {
    description: "Symphony resolve state",
    risk: "read",
    params: {issueId: { type: "string" }, stateName: { type: "string" }},
    paramsSchema: z.object({ issueId: id, stateName: text }).strict(),
    directApi: {
      method: "POST",
      url: "https://api.linear.app/graphql",
      mapBody: (params) => ({ query: `
  query SymphonyResolveStateId($issueId: String!, $stateName: String!) {
    issue(id: $issueId) {
      team {
        states(filter: {name: {eq: $stateName}}, first: 1) {
          nodes {
            id
          }
        }
      }
    }
  }
`, variables: params }),
    },
  },
  symphony_update_state: {
    description: "Symphony update state",
    risk: "write",
    params: {issueId: { type: "string" }, stateId: { type: "string" }},
    paramsSchema: z.object({ issueId: id, stateId: id }).strict(),
    directApi: {
      method: "POST",
      url: "https://api.linear.app/graphql",
      mapBody: (params) => ({ query: `
  mutation SymphonyUpdateIssueState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: {stateId: $stateId}) {
      success
    }
  }
`, variables: params }),
    },
  },
  symphony_get_issue: {
    description: "Symphony get issue",
    risk: "read",
    params: {issueId: { type: "string" }},
    paramsSchema: z.object({ issueId: id }).strict(),
    directApi: {
      method: "POST",
      url: "https://api.linear.app/graphql",
      mapBody: (params) => ({ query: `
  query SymphonyGetIssue($issueId: String!) {
    issue(id: $issueId) {
      id identifier title description url state { name }
      comments(first: 50) { nodes { id body url } }
      team { states(first: 50) { nodes { id name } } }
    }
  }
`, variables: params }),
    },
  },
  symphony_update_comment: {
    description: "Symphony update comment",
    risk: "write",
    params: {id: { type: "string" }, body: { type: "string" }},
    paramsSchema: z.object({ id, body: z.string().min(1).max(10000) }).strict(),
    directApi: {
      method: "POST",
      url: "https://api.linear.app/graphql",
      mapBody: (params) => ({ query: `
  mutation SymphonyUpdateComment($id: String!, $body: String!) {
    commentUpdate(id: $id, input: {body: $body}) { success comment { id url } }
  }
`, variables: params }),
    },
  },
};

export type SymphonyGraphqlFailure = 'configuration' | 'rate_limited' | 'transient' | 'operation';

/** Inspect only structured codes, never provider error-message text.
 * Linear documents HTTP 400 + RATELIMITED at
 * https://linear.app/developers/rate-limiting#handling-rate-limit-errors
 */
export function classifySymphonyGraphqlFailure(body: unknown): SymphonyGraphqlFailure | null {
  if (!body || typeof body !== 'object' || !('errors' in body) || !Array.isArray(body.errors) || body.errors.length === 0) return null;
  const codes = body.errors.slice(0, 100).map((error: unknown) => {
    if (!error || typeof error !== 'object' || !('extensions' in error)) return undefined;
    const ext = error.extensions;
    return ext && typeof ext === 'object' && 'code' in ext && typeof ext.code === 'string' ? ext.code : undefined;
  });
  if (codes.some(code => ['UNAUTHENTICATED', 'AUTHENTICATION_ERROR', 'GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'CONFIGURATION_ERROR'].includes(code ?? ''))) return 'configuration';
  if (codes.includes('RATELIMITED')) return 'rate_limited';
  if (codes.some(code => ['INTERNAL_SERVER_ERROR', 'INTERNAL_ERROR'].includes(code ?? ''))) return 'transient';
  return 'operation';
}
