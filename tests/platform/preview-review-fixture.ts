import { reconcilePreviews } from "../../scripts/ci/preview-review.mjs";
export const head = "a".repeat(40),
  pin = "b".repeat(40),
  execution = "e".repeat(40),
  repo = { owner: "HamedMP", repo: "matrix-os" },
  now = Date.parse("2026-10-19T10:00:00Z");
export const pr = (number: number, extra: any = {}) => ({
  number,
  title: `Change ${number}`,
  state: "open",
  created_at: `2026-10-${String(number).padStart(2, "0")}T09:00:00Z`,
  user: { login: `author-${number}` },
  labels: [{ name: "preview" }],
  head: { sha: head, repo: { full_name: "HamedMP/matrix-os" } },
  base: { ref: "main" },
  ...extra,
});
export function fixture(prs: any[] = [pr(1)]) {
  const leases: any[] = [],
    machines: any[] = [],
    runs: any[] = [],
    dispatches: any[] = [],
    cancelled: number[] = [],
    privateDeletes: number[] = [],
    comments = new Map<number, any>();
  let deletionFails = false,
    dispatchFails = false;
  const github: any = {
    graphql: async ({}: any, args: any) =>
      args.number
        ? {
            repository: {
              pullRequest: (() => {
                const p = prs.find((p) => p.number === args.number),
                  c = comments.get(args.number);
                return {
                  headRefOid: p.head.sha,
                  state: p.state.toUpperCase(),
                  labels: { nodes: p.labels, pageInfo: { hasNextPage: false } },
                  comments: {
                    nodes: c
                      ? [
                          {
                            databaseId: c.id,
                            body: c.body,
                            author: {
                              login: "github-actions[bot]",
                              __typename: "Bot",
                            },
                          },
                        ]
                      : [],
                    pageInfo: { hasPreviousPage: false },
                  },
                };
              })(),
            },
          }
        : {
            nodes: args.ids.map((id: string) => {
              const r = leases.find((l) => l.node_id === id);
              return {
                id,
                latestStatus: {
                  state: r.state.toUpperCase(),
                  description: r.description ?? "",
                },
              };
            }),
          },
    rest: {
      pulls: {
        list: async ({ state, page = 1, per_page = 100 }: any) => ({ data: prs.filter((p) => p.state === state).slice((page - 1) * per_page, page * per_page) }),
        get: async ({ pull_number }: any) => ({
          data: prs.find((p) => p.number === pull_number),
        }),
        listFiles: async () => ({
          data: [{ filename: "packages/gateway/src/server.ts" }],
        }),
      },
      repos: {
        listDeployments: async () => ({ data: leases }),
        deleteDeployment: async () => ({ data: {} }),
        createDeployment: async (args: any) => {
          const id = leases.length + 1,
            row = {
              ...args,
              id,
              node_id: `node-${id}`,
              sha: args.ref,
              state: "pending",
              creator: { login: "github-actions[bot]", type: "Bot" },
              created_at: "2026-10-19T10:00:00Z",
            };
          leases.push(row);
          return { data: row };
        },
        createDeploymentStatus: async ({
          deployment_id,
          state,
          description,
        }: any) => {
          Object.assign(
            leases.find((l) => l.id === deployment_id),
            { state, description },
          );
          return { data: {} };
        },
        getBranch: async ({ branch }: any) => ({
          data: {
            name: branch,
            commit: { sha: branch === "main" ? pin : execution },
          },
        }),
        compareCommitsWithBasehead: async () => ({
          data: { status: "identical", merge_base_commit: { sha: pin } },
        }),
      },
      git: {
        getCommit: async ({ commit_sha }: any) => ({
          data: {
            sha: commit_sha,
            tree: { sha: "f".repeat(40) },
            parents: commit_sha === execution ? [{ sha: pin }] : [],
          },
        }),
      },
      actions: {
        listWorkflowRuns: async ({ workflow_id, event, status }: any) => ({
          data: {
            workflow_runs: runs.filter(
              (r) =>
                r.path === `.github/workflows/${workflow_id}` &&
                r.event === event &&
                (!status || r.status === status),
            ),
          },
        }),
        createWorkflowDispatch: async (args: any) => {
          dispatches.push(args);
          if (dispatchFails) throw new Error("ambiguous transport");
          return { data: {} };
        },
        cancelWorkflowRun: async ({ run_id }: any) => {
          cancelled.push(run_id);
          return { data: {} };
        },
        listWorkflowRunArtifacts: async () => ({ data: { artifacts: [] } }),
      },
      issues: {
        listComments: async ({ issue_number }: any) => ({
          data: comments.has(issue_number) ? [comments.get(issue_number)] : [],
        }),
        createComment: async ({ issue_number, body }: any) => {
          comments.set(issue_number, {
            id: issue_number,
            body,
            user: { login: "github-actions[bot]" },
          });
          return { data: {} };
        },
        updateComment: async ({ comment_id, body }: any) => {
          comments.set(comment_id, {
            id: comment_id,
            body,
            user: { login: "github-actions[bot]" },
          });
          return { data: {} };
        },
        removeLabel: async ({ issue_number, name }: any) => {
          const p = prs.find((p) => p.number === issue_number);
          p.labels = p.labels.filter((l: any) => l.name !== name);
          return { data: {} };
        },
      },
    },
  };
  const platform = {
    deletionConfirmed: async () => true,
    removePrivate: async (pr: number) => {
      privateDeletes.push(pr);
      return { destroyed: 0, failed: 0 };
    },
    fleet: async () => [...machines],
    remove: async (m: any) => {
      if (deletionFails) throw new Error("delete failed");
      machines.splice(
        machines.findIndex((x) => x.machineId === m.machineId),
        1,
      );
      return { deleted: true };
    },
  };
  const reconcile = (options: any = {}) =>
    reconcilePreviews({
      github,
      repo,
      platform,
      controllerSha: pin,
      executionRef: `ci-execution/${pin}`,
      owner: "user_team",
      now,
      ...options,
    });
  function reserve(number = 1, extra: any = {}) {
    const row = {
      id: leases.length + 1,
      node_id: `node-${leases.length + 1}`,
      sha: head,
      task: "matrix-preview-v1",
      environment: `review-pr-${number}`,
      creator: { login: "github-actions[bot]", type: "Bot" },
      state: "in_progress",
      created_at: "2026-10-19T09:00:00Z",
      payload: {
        schema: "matrix-preview-v1",
        pr: number,
        head,
        controllerSha: pin,
        desktop: false,
        owner: "user_team",
        expiresAt: "2026-10-22T09:00:00Z",
      },
      ...extra,
    };
    leases.push(row);
    return row;
  }
  function web(row: any, id = 101, extra: any = {}) {
    const r = {
      id,
      run_attempt: 1,
      workflow_id: 88,
      event: "workflow_dispatch",
      head_branch: `ci-execution/${pin}`,
      head_sha: execution,
      path: ".github/workflows/preview-vps.yml",
      repository: { full_name: "HamedMP/matrix-os" },
      head_repository: { full_name: "HamedMP/matrix-os" },
      display_title: `preview-web-v1 pr=${row.payload.pr} head=${row.payload.head} lease=${row.id}`,
      status: "completed",
      conclusion: "success",
      created_at: "2026-10-18T23:59:00Z",
      ...extra,
    };
    runs.push(r);
    return r;
  }
  function machine(number = 1, extra: any = {}) {
    const m = {
      machineId: "10000000-0000-4000-8000-000000000001",
      handle: `pr-${number}`,
      runtimeSlot: `pr-${number}`,
      provisioningClass: "preview",
      clerkUserId: "user_team",
      status: "running",
      provisionedAt: "2026-10-19T09:00:00Z",
      healthy: true,
      deletedAt: null,
      runtimeVersion: `v2026.10.19-pr${number}-101-1-aaaaaaa`,
      ...extra,
    };
    machines.push(m);
    return m;
  }
  return {
    github,
    platform,
    leases,
    machines,
    runs,
    dispatches,
    cancelled,
    privateDeletes,
    comments,
    reconcile,
    reserve,
    web,
    machine,
    failDeletion: () => {
      deletionFails = true;
    },
    failDispatch: () => {
      dispatchFails = true;
    },
  };
}
