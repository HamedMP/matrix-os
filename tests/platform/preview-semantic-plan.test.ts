import { describe, expect, it, vi } from "vitest";
import { composeAgentPlan, validateAgentPlan, readAgentPlan } from "../../scripts/ci/preview-semantic-plan.mjs";
import { publishAgentTestPlan, publishAwaitingPreviewActivation, upsertComment, publishReviewComment } from "../../scripts/ci/preview-review-api.mjs";
const head = "a".repeat(40), other = "b".repeat(40);
const repo = { owner: "HamedMP", repo: "matrix-os" };
const now = Date.now();
const marker = "<!-- matrix-preview-review-v1 -->";
const status = `${marker}\n**PR preview: Ready**\n- Source: \`${head}\`\n- Web: [Open preview](https://app.matrix-os.com/vm/pr-2764)\n- Downloads: https://github.com/HamedMP/matrix-os/actions/runs/1`;
function plan() { return { schema: "matrix-preview-agent-plan-v1", repository: "hamedmp/matrix-os", pr: 2764, head, generatedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), scenarios: [{ surface: "Platform API", behavior: "Physical deletion holds capacity", steps: ["Check pending provider deletion"], requiredEvidence: ["Actual provider absence before slot release"] }] }; }
function fixture(body?: string) {
  const comments: any[] = body ? [{ id: 7, body, user: { login: "github-actions[bot]", type: "Bot" } }] : [];
  const pr = { number: 2764, state: "open", head: { sha: head, repo: { full_name: "HamedMP/matrix-os" } }, labels: [] };
  const github: any = { rest: { pulls: { get: vi.fn(async () => ({ data: pr })) }, issues: { listComments: vi.fn(async () => ({ data: comments })), createComment: vi.fn(async (args: any) => { comments.push({ id: 8, ...args, user: { login: "github-actions[bot]", type: "Bot" } }); }), updateComment: vi.fn(async (args: any) => { comments.find(c => c.id === args.comment_id).body = args.body; }) } } };
  return { github, comments, pr };
}
describe("source-bound semantic preview plans", () => {
  it("drops stale plans on disabled source refresh and then accepts the new head plan", async () => {
    const f = fixture(composeAgentPlan(status, "", {repo, pr: 2764, plan: plan(), now}));
    f.pr.labels = [{name: "preview"}];
    f.pr.head.sha = other;
    await expect(publishAgentTestPlan(f.github, repo, 2764, {...plan(), head: other})).rejects.toThrow("refresh status first");
    await publishAwaitingPreviewActivation(f.github, repo, 2764, other);
    expect(f.comments[0].body).toContain(`Source: \`${other}\``);
    expect(f.comments[0].body).not.toContain("Physical deletion");
    await publishAgentTestPlan(f.github, repo, 2764, {...plan(), head: other});
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0].body).toContain("Physical deletion");
  });
  it("rejects malformed optional envelopes while surfacing unexpected parser failures", () => {
    const body = composeAgentPlan(status, "", {repo, pr: 2764, plan: plan(), now});
    const invalid = `<!-- matrix-preview-agent-plan-v1:${Buffer.from("{").toString("base64url")} -->`;
    expect(readAgentPlan(invalid, {repo, pr: 2764, head, now})).toBeNull();
    for (const unexpected of [new Error("unexpected trusted context failure"), new SyntaxError("unexpected trusted context syntax failure")]) {
      const context = {repo, pr: 2764, now, get head() {throw unexpected}};
      expect(() => readAgentPlan(body, context)).toThrow(unexpected);
    }
  });
  it("preserves a valid plan across status refresh without replacing authoritative links", () => {
    const first = composeAgentPlan(status, "", { repo, pr: 2764, plan: plan(), now });
    expect(first).toContain("Actual provider absence");
    const refreshed = composeAgentPlan(status.replace("Ready", "Validation in progress"), first, { repo, pr: 2764, now });
    expect(refreshed).toContain("Validation in progress");
    expect(refreshed).toContain("https://app.matrix-os.com/vm/pr-2764");
    expect(readAgentPlan(refreshed, { repo, pr: 2764, head, now })).toEqual(plan());
    expect(refreshed.match(/Agent test plan/g)).toHaveLength(1);
  });
  it("drops optional inherited plans when a growing queue needs the comment capacity", () => {
    const previous = composeAgentPlan(status, "", {repo, pr: 2764, plan: plan(), now});
    const waiting = `${status.replace("Ready", "Waiting")}\nQueue: ${"x".repeat(59000)}`;
    expect(waiting.length).toBeLessThan(60000);
    expect(composeAgentPlan(waiting, previous, {repo, pr: 2764, now})).toBe(waiting);
    // The current body may also carry the optional plan during a status refresh.
    const embedded = previous.replace(status, waiting);
    expect(composeAgentPlan(embedded, "", {repo, pr: 2764, now})).toBe(waiting);
    // An explicit plan publication must still report that the plan cannot fit.
    expect(() => composeAgentPlan(waiting, previous, {repo, pr: 2764, plan: plan(), now})).toThrow();
  });
  it("publishes fresh REST and GraphQL status even when the inherited plan no longer fits", async () => {
    const previous = composeAgentPlan(status, "", {repo, pr: 2764, plan: plan(), now});
    const waiting = `${status.replace("Ready", "Waiting")}\nQueue: ${"x".repeat(59000)}`;
    const f = fixture(previous);
    await upsertComment(f.github, repo, 2764, waiting);
    expect(f.comments[0].body).toBe(waiting);
    await publishReviewComment(f.github, repo, 2764, waiting.replace("Waiting", "Building"), {old: {databaseId: 7, body: previous}});
    expect(f.comments[0].body).toBe(waiting.replace("Waiting", "Building"));
    expect(f.comments).toHaveLength(1);
    expect(f.github.rest.issues.updateComment).toHaveBeenCalledTimes(2);
  });
  it("drops prior-head, expired, malformed and wrong-repository envelopes", () => {
    const first = composeAgentPlan(status, "", { repo, pr: 2764, plan: plan(), now });
    expect(composeAgentPlan(status.replace(head, other), first, { repo, pr: 2764, now })).not.toContain("Agent test plan");
    expect(composeAgentPlan(status, first, { repo, pr: 2764, now: now + 7200000 })).not.toContain("Agent test plan");
    expect(readAgentPlan(first.replace(/plan-v1:[A-Za-z0-9_-]+/, "plan-v1:garbage"), { repo, pr: 2764, head, now })).toBeNull();
    expect(readAgentPlan(first, { repo: { owner: "fork", repo: "matrix-os" }, pr: 2764, head, now })).toBeNull();
    expect(composeAgentPlan(status, first, { repo, pr: 999, now })).not.toContain("Agent test plan");
  });
  it("rejects extra authority fields, unbounded data, invalid times and unknown surfaces", () => {
    for (const candidate of [ { ...plan(), approval: true }, { ...plan(), generatedAt: new Date(now + 600000).toISOString() }, { ...plan(), expiresAt: new Date(now + 73*3600000).toISOString() }, { ...plan(), scenarios: Array(13).fill(plan().scenarios[0]) }, { ...plan(), scenarios: [{ ...plan().scenarios[0], behavior: "a".repeat(601) }] }, { ...plan(), scenarios: [{ ...plan().scenarios[0], surface: "Production deploy" }] } ]) expect(() => validateAgentPlan(candidate, { repo, pr: 2764, head, now })).toThrow();
  });
  it("renders agent text literally, without HTML, mentions, URLs or Markdown links", () => {
    const p = plan(); p.scenarios[0].behavior = '<img src=x> [approve](https://evil.example) @everyone `run` **pass**';
    const body = composeAgentPlan(status, "", { repo, pr: 2764, plan: p, now });
    const rendered = body.slice(body.indexOf("**Agent test plan"), body.indexOf("<!-- matrix-preview-agent-plan-v1:"));
    expect(rendered).not.toContain('<img'); expect(rendered).not.toContain('[approve]('); expect(rendered).not.toContain('https://evil'); expect(rendered).not.toContain('@everyone'); expect(rendered).not.toContain('**pass**');
    expect(rendered).toContain('Advisory only');
  });
  it("keeps a plan in REST and GraphQL status publication paths", async () => {
    const body = composeAgentPlan(status, "", { repo, pr: 2764, plan: plan(), now });
    const f = fixture(body);
    await upsertComment(f.github, repo, 2764, status.replace("Ready", "Waiting"));
    expect(f.comments[0].body).toContain("Physical deletion");
    await publishReviewComment(f.github, repo, 2764, status.replace("Ready", "Building"), { old: { databaseId: 7, body: f.comments[0].body } });
    expect(f.comments[0].body).toContain("Physical deletion");
    expect(f.comments[0].body).toContain("Building");
  });
  it("publishes into existing comment, preserves status and is idempotent", async () => {
    const f = fixture(status);
    await publishAgentTestPlan(f.github, repo, 2764, plan());
    expect(f.github.rest.pulls.get).toHaveBeenCalledTimes(2);
    expect(f.comments).toHaveLength(1); expect(f.comments[0].body).toContain("https://app.matrix-os.com/vm/pr-2764");
    expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
    await publishAgentTestPlan(f.github, repo, 2764, plan());
    expect(f.github.rest.issues.updateComment).toHaveBeenCalledTimes(1);
  });
  it("preserves plans through disabled status and accepts plans after disabled status", async () => {
    const f = fixture(composeAgentPlan(status, "", {repo, pr: 2764, plan: plan(), now}));
    f.pr.labels = [{name: "preview"}];
    await publishAwaitingPreviewActivation(f.github, repo, 2764, head);
    expect(f.comments[0].body).toContain("awaiting reviewed controller activation");
    expect(f.comments[0].body).toContain("Physical deletion");
    const g = fixture(); g.pr.labels = [{name: "preview"}];
    await publishAwaitingPreviewActivation(g.github, repo, 2764, head);
    await publishAgentTestPlan(g.github, repo, 2764, plan());
    expect(g.comments).toHaveLength(1);
    expect(g.comments[0].body).toContain("Physical deletion");
  });
  it("creates only one clearly advisory comment when no status exists", async () => {
    const f = fixture(); await publishAgentTestPlan(f.github, repo, 2764, plan()); await publishAgentTestPlan(f.github, repo, 2764, plan());
    expect(f.comments).toHaveLength(1); expect(f.comments[0].body).toContain("No preview or qualification evidence");
    expect(f.comments[0].body.startsWith(marker)).toBe(true);
  });
  it("refuses stale-head races, forks, closed PRs and stale status bodies", async () => {
    for (const changed of [ { state: "closed" }, { head: { sha: other, repo: { full_name: "HamedMP/matrix-os" } } }, { head: { sha: head, repo: { full_name: "evil/matrix-os" } } } ]) {
      const f = fixture(status); f.github.rest.pulls.get.mockResolvedValueOnce({ data: structuredClone(f.pr) }).mockResolvedValueOnce({ data: { ...f.pr, ...changed } });
      await expect(publishAgentTestPlan(f.github, repo, 2764, plan())).rejects.toThrow();
      expect(f.github.rest.issues.updateComment).not.toHaveBeenCalled();
    }
    const f = fixture(status.replace(head, other)); await expect(publishAgentTestPlan(f.github, repo, 2764, plan())).rejects.toThrow();
    expect(f.github.rest.issues.updateComment).not.toHaveBeenCalled();
  });
});
