import { sharedMachine } from "./preview-review-model.mjs";
export const request = { timeout: 15000 };
export async function pages(method, args, key) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const { data } = await method({ ...args, per_page: 100, page, request });
    const rows = key ? data[key] : data;
    if (!Array.isArray(rows)) throw new Error("Preview inventory unavailable");
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new Error("Preview inventory pagination limit reached");
}
export function platformClient({
  origin = "https://app.matrix-os.com",
  token,
  fetchImpl = fetch,
}) {
  if (
    new URL(origin).origin !== origin ||
    !origin.startsWith("https://") ||
    !token
  )
    throw new Error("Preview operator configuration unavailable");
  async function call(path, method = "GET") {
    const response = await fetchImpl(`${origin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error("Preview operator request failed");
    if (Number(response.headers.get("content-length")) > 2_000_000)
      throw new Error("Preview operator response too large");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Preview operator response unavailable");
    const body = Buffer.alloc(2_000_000);
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000)
          throw new Error("Preview operator response too large");
        Buffer.from(value).copy(body, size - value.byteLength);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(body.subarray(0, size).toString("utf8"));
  }
  return {
    async fleet() {
      // Preserve actual runtime health while adding legacy tombstones that
      // disappear from the active fleet before physical provider cleanup.
      const snapshots = [await call("/vps/fleet"), await call("/vps/preview-capacity")];
      const machines = new Map();
      for (const data of snapshots) {
        if (data.truncated || !Array.isArray(data.machines) || data.machines.length >= 500)
          throw new Error("Preview fleet inventory incomplete");
        const ids = new Set();
        for (const row of data.machines) {
          if (typeof row.machineId !== "string" || !row.machineId.length || row.machineId.length > 100 || ids.has(row.machineId))
            throw new Error("Preview fleet identity incomplete");
          ids.add(row.machineId);
          machines.set(row.machineId, { ...machines.get(row.machineId), ...row });
        }
      }
      return [...machines.values()];
    },
    async removePrivate(pr) {
      if (!Number.isSafeInteger(pr) || pr < 1)
        throw new Error("Invalid preview PR");
      const data = await call(`/vps/private-previews?pr=${pr}`, "DELETE");
      if (data.failed) throw new Error("Private Preview cleanup incomplete");
      return data;
    },
    async deletionConfirmed(pr, owner) {
      if (
        !Number.isSafeInteger(pr) ||
        pr < 1 ||
        !/^user_[A-Za-z0-9]+$/.test(owner ?? "")
      )
        throw new Error("Invalid preview cleanup scope");
      const data = await call(
        `/vps/preview-cleanup?pr=${pr}&owner=${encodeURIComponent(owner)}`,
      );
      return data.confirmed === true;
    },
    async remove(machine) {
      if (!sharedMachine(machine) || !/^[a-f0-9-]{36}$/.test(machine.machineId))
        throw new Error("Invalid preview cleanup target");
      return call(`/vps/${machine.machineId}`, "DELETE");
    },
  };
}
export async function deploymentStates(github, repo, rows) {
  const states = new Map();
  for (let start = 0; start < rows.length; start += 100) {
    const ids = rows.slice(start, start + 100).map((r) => r.node_id);
    const data = await github.graphql(
      "query($ids:[ID!]!){nodes(ids:$ids){... on Deployment{id latestStatus{state description}}}}",
      { ids, request },
    );
    for (const node of data.nodes) {
      if (node)
        states.set(node.id, {
          state: node.latestStatus?.state?.toLowerCase() ?? "pending",
          description: node.latestStatus?.description ?? "",
        });
    }
  }
  return rows.map((row) => {
    if (!states.has(row.node_id))
      throw new Error("Preview reservation status unavailable");
    return { ...row, ...states.get(row.node_id) };
  });
}
export async function upsertComment(github, repo, pr, body) {
  const rows = await pages(github.rest.issues.listComments, {
    ...repo,
    issue_number: pr,
  });
  const old = rows.find(
    (c) =>
      c.user?.login === "github-actions[bot]" &&
      c.body?.startsWith("<!-- matrix-preview-review-v1 -->"),
  );
  if (old?.body === body) return;
  if (old)
    await github.rest.issues.updateComment({
      ...repo,
      comment_id: old.id,
      body,
      request,
    });
  else
    await github.rest.issues.createComment({
      ...repo,
      issue_number: pr,
      body,
      request,
    });
}

// Share immutable controller/tree proofs within one reconciliation. Per-run
// identity checks still execute; no proof survives into the next snapshot.
export function originReadSnapshot(github) {
  const cache = new Map();
  const memo = (name, method) => (args) => {
    const key = name + JSON.stringify(args);
    if (!cache.has(key)) {
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(key, method(args));
    }
    return cache.get(key);
  };
  return {
    ...github,
    rest: {
      ...github.rest,
      repos: {
        ...github.rest.repos,
        getBranch: memo("branch", github.rest.repos.getBranch),
        compareCommitsWithBasehead: memo(
          "ancestry",
          github.rest.repos.compareCommitsWithBasehead,
        ),
      },
      git: {
        ...github.rest.git,
        getCommit: memo("commit", github.rest.git.getCommit),
      },
    },
  };
}

// One GraphQL point replaces two REST reads for each reviewer comment. REST and
// GraphQL have separate Actions quotas; keep the current-head check at publication.
export async function reviewPublication(github, repo, number) {
  const data = await github.graphql(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid state labels(first:100){nodes{name} pageInfo{hasNextPage}} comments(last:100){nodes{databaseId body author{login __typename}} pageInfo{hasPreviousPage}}}}}`,
    { owner: repo.owner, name: repo.repo, number, request },
  );
  const pr = data.repository?.pullRequest;
  if (!pr || pr.labels.pageInfo.hasNextPage)
    throw new Error("Preview publication identity unavailable");
  const old = pr.comments.nodes.find(
    (c) =>
      c.author?.__typename === "Bot" &&
      ["github-actions", "github-actions[bot]"].includes(c.author.login) &&
      c.body?.startsWith("<!-- matrix-preview-review-v1 -->"),
  );
  return {
    head: pr.headRefOid,
    open: pr.state === "OPEN",
    labeled: pr.labels.nodes.some((l) => l.name === "preview"),
    old,
    previous: pr.comments.pageInfo.hasPreviousPage,
  };
}
export async function publishReviewComment(
  github,
  repo,
  number,
  body,
  snapshot,
) {
  if (snapshot.old?.body === body) return;
  if (snapshot.old)
    await github.rest.issues.updateComment({
      ...repo,
      comment_id: snapshot.old.databaseId,
      body,
      request,
    });
  else if (snapshot.previous) await upsertComment(github, repo, number, body);
  else
    await github.rest.issues.createComment({
      ...repo,
      issue_number: number,
      body,
      request,
    });
}
