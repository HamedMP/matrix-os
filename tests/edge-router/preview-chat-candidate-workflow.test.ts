import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const workflowPath = new URL("../../.github/workflows/preview-chat-candidate-edge.yml", import.meta.url);

describe("one-chat Platform candidate Edge deployment", () => {
  it("admits the actual current same-repository labeled stack PR rather than the retired PR", () => {
    const workflow = parse(readFileSync(workflowPath, "utf8"));
    const gate = workflow.jobs.test.if as string;
    // Evaluate the actual bounded conjunction emitted by GitHub's job gate.
    function admit(number: number, label = "preview-chat-candidate-route", repo = "example/matrix-os") {
      const github = { repository: "example/matrix-os", event: { label: { name: label },
        pull_request: { number, head: { ref: "codex/current-stack", repo: { full_name: repo } } } } };
      const value = (path: string): unknown => path.startsWith("'") ? path.slice(1, -1)
        : /^\d+$/.test(path) ? Number(path) : path.split(".").slice(1).reduce<unknown>((current, part) =>
          current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined, github);
      return gate.trim().split(/\s*&&\s*/).every(clause => {
        const match = clause.trim().match(/^(github[\w.]+)\s*(==|>=|<=)\s*('[^']*'|github[\w.]+|\d+)$/);
        if (!match) throw new Error("Unsupported workflow admission condition");
        const left = value(match[1]!), right = value(match[3]!);
        if (match[2] === "==") return left === right;
        return typeof left === 'number' && typeof right === 'number' && (match[2] === '>=' ? left >= right : left <= right);
      });
    }
    expect(admit(2348)).toBe(true);
    expect(admit(2348, "ready-for-ci")).toBe(false);
    expect(admit(2348, undefined, "fork/matrix-os")).toBe(false);
    expect(admit(0)).toBe(false);
    expect(admit(1_000_000_000)).toBe(false);
  });
  it("probes only read access to the bounded funded Preview gateway without exposing its settings", () => {
    const source = readFileSync(workflowPath, "utf8");
    expect(source).toContain("Cloudflare AI Gateway read permission probe");
    expect(source).toContain("--request GET");
    expect(source).toContain("/ai-gateway/gateways/matrix-funded-preview");
    expect(source).toContain(".success == true and .result.id == \"matrix-funded-preview\"");
    expect(source).toContain("readable=${readable}");
    expect(source).not.toMatch(/--request (?:PUT|POST|PATCH|DELETE).*ai-gateway/);
    expect(source.indexOf("# Cloudflare AI Gateway read permission probe.")).toBeGreaterThan(
      source.indexOf('preview-chat-candidate-selector.py selector'),
    );
    expect(source.indexOf("# Cloudflare AI Gateway read permission probe.")).toBeGreaterThan(
      source.indexOf('gh api "repos/${GITHUB_REPOSITORY}/pulls/${REVIEWED_PR}"', source.indexOf('Deploy exact reviewed')),
    );
  });

  it("requires a deliberate same-repository PR label and an approved exact head before Production secrets", () => {
    const source = readFileSync(workflowPath, "utf8");
    expect(source).toContain("pull_request:");
    expect(source).toContain("types: [labeled]");
    expect(source).not.toContain("pull_request_target:");
    expect(source).not.toContain("workflow_dispatch:");
    expect(source).toContain("preview-chat-candidate-route");
    expect(source).toContain("github.event.pull_request.number <= 999999999");
    expect(source).not.toContain("pulls/2045");
    expect(source).not.toContain("pr2045-preview-chat-candidate");
    expect(source).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(source).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(source).toContain("environment: Production");
    expect(source).toContain("needs: test");
    expect(source).toContain("gcloud secrets versions access latest");
    expect(source).toContain('--out-file="$raw_selector" --quiet');
    expect(source).toContain('--secret "preview-chat-candidate-pr-${REVIEWED_PR}"');
    expect(source).toContain("REVIEWED_REF: ${{ github.event.pull_request.head.ref }}");
    expect(source).toContain('gh api "repos/${GITHUB_REPOSITORY}/pulls/${REVIEWED_PR}"');
    expect(source).toContain("--secrets-file");
    expect(source).toContain("x-matrix-preview-platform-route: candidate");
    expect(source).toContain('status_code="$(curl');
    expect(source).toContain('if [ "$status_code" != "401" ] && [ "$status_code" != "403" ] && [ "$unauth_login" != true ]; then');
    expect(source).toContain('"$status_code" = "200"');
    expect(source).toContain('^content-type: text/html');
    expect(source).toContain('Sign in to continue to your Matrix computer');
    expect(source).toContain("trap cleanup EXIT");
    const workflow = parse(source);
    const steps = workflow.jobs.deploy.steps as Array<{ name?: string; uses?: string; run?: string }>;
    expect(steps.findIndex(step => step.name === 'Check current PR head and trigger label')).toBeLessThan(
      steps.findIndex(step => step.name === 'Authenticate to Google Cloud'));
    const deploy = steps.find(step => step.name === 'Deploy exact reviewed Edge Router and selector')!.run!;
    const probe = deploy.indexOf('# Cloudflare AI Gateway read permission probe.');
    const mutate = deploy.indexOf('exec wrangler deploy');
    const finalCheck = deploy.lastIndexOf('check_current_pr');
    const finalSelector = deploy.lastIndexOf('preview-chat-candidate-selector.py selector');
    expect(finalCheck).toBeGreaterThan(probe); expect(finalCheck).toBeLessThan(mutate);
    expect(finalSelector).toBeGreaterThan(finalCheck); expect(finalSelector).toBeLessThan(mutate);
    expect(deploy.indexOf('check_current_pr\n')).toBeLessThan(deploy.indexOf('gcloud secrets versions access'));
    expect(source).toContain('/vm/${handle}/~runtime/${handle}/api/chats/${chat_id}/turns');
    expect(source).not.toMatch(/echo\s+.*(?:CLOUDFLARE_API_TOKEN|chatId|candidateOrigin)/);
  });
});


describe("executable current-PR candidate selector", () => {
  const owned: string[] = [];
  afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
  const sha = "a".repeat(40), ref = "codex/current-stack", repo = "example/matrix-os";
  const event = { action: "labeled", label: { name: "preview-chat-candidate-route" }, pull_request: {
    number: 2348, state: "open", labels: [{ name: "preview-chat-candidate-route" }],
    head: { sha, ref, repo: { full_name: repo } } } };
  function payload() { return { prNumber: 2348, approvedHeadSha: sha, approvedHeadRef: ref,
    handle: "pr-2348", chatId: "chat_test_one", candidateOrigin: "https://pr2348-review---matrix-platform-example.run.app",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() }; }
  function run(mode: 'selector' | 'admit' | 'current', data: unknown = payload(), eventValue: unknown = event, current: unknown = event.pull_request) {
    const directory = mkdtempSync(join(tmpdir(), 'preview-selector-test-')); owned.push(directory);
    const eventPath = join(directory, 'event.json'), raw = join(directory, 'selector.json'), output = join(directory, 'bindings.json');
    const config = join(directory, 'packages/edge-router/wrangler.toml');
    mkdirSync(join(directory, 'packages/edge-router'), { recursive: true });
    writeFileSync(eventPath, JSON.stringify(eventValue)); writeFileSync(raw, typeof data === 'string' ? data : JSON.stringify(data));
    writeFileSync(config, '[vars]\nPLATFORM_ORIGIN = "https://matrix-platform-example.run.app"\n');
    const helper = new URL('../../scripts/ci/preview-chat-candidate-selector.py', import.meta.url);
    const result = spawnSync('python3', [helper.pathname, mode, '--event', eventPath, '--repository', repo,
      '--pr', '2348', '--sha', sha, '--ref', ref,
      ...(mode === 'selector' ? ['--raw', raw, '--output', output, '--config', config] : [])],
    { encoding: 'utf8', input: JSON.stringify(current), timeout: 5_000 });
    return { ...result, bindings: existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null };
  }
  it('accepts a fresh reviewed selector for the current stack PR and emits only four routing bindings', () => {
    const selected = payload(), result = run('selector', selected);
    expect(result.status, result.stderr).toBe(0);
    expect(result.bindings).toEqual({ PREVIEW_CHAT_CANDIDATE_ORIGIN: selected.candidateOrigin,
      PREVIEW_CHAT_CANDIDATE_HANDLE: 'pr-2348', PREVIEW_CHAT_CANDIDATE_CHAT_ID: 'chat_test_one',
      PREVIEW_CHAT_CANDIDATE_EXPIRES_AT: selected.expiresAt });
    expect(result.stdout).not.toContain(selected.chatId);
    expect(result.stdout).not.toContain(selected.candidateOrigin);
  });
  it.each([
    ['old PR', { prNumber: 2045, handle: 'pr-2045', candidateOrigin: 'https://pr2045-review---matrix-platform-example.run.app' }],
    ['head SHA', { approvedHeadSha: 'b'.repeat(40) }],
    ['branch', { approvedHeadRef: 'codex/old-branch' }],
    ['handle', { handle: 'pr-2347' }],
    ['Chat wildcard', { chatId: '*' }],
    ['expiry passed', { expiresAt: new Date(0).toISOString() }],
    ['expiry too far', { expiresAt: new Date(Date.now() + 7_300_000).toISOString() }],
    ['expiry timezone', { expiresAt: '2099-01-01T00:00:00+00:00' }],
    ['origin wrong PR', { candidateOrigin: 'https://pr2045-review---matrix-platform-example.run.app' }],
    ['origin wrong service', { candidateOrigin: 'https://pr2348-review---another-platform-example.run.app' }],
    ['origin whitespace', { candidateOrigin: '\nhttps://pr2348-review---matrix-platform-example.run.app' }],
    ['origin insecure', { candidateOrigin: 'http://pr2348-review---matrix-platform-example.run.app' }],
    ['origin credentials', { candidateOrigin: 'https://user@pr2348-review---matrix-platform-example.run.app' }],
    ['origin port', { candidateOrigin: 'https://pr2348-review---matrix-platform-example.run.app:443' }],
    ['origin path', { candidateOrigin: 'https://pr2348-review---matrix-platform-example.run.app/api' }],
    ['origin query', { candidateOrigin: 'https://pr2348-review---matrix-platform-example.run.app?override=1' }],
    ['origin fragment', { candidateOrigin: 'https://pr2348-review---matrix-platform-example.run.app#route' }],
    ['extra field', { broadRouting: true }],
    ['noninteger PR', { prNumber: '2348' }],
  ])('rejects selector drift: %s', (_name, changed) => {
    const result = run('selector', { ...payload(), ...(changed as object) });
    expect(result.status).not.toBe(0); expect(result.bindings).toBeNull();
    expect(result.stderr).toContain('Candidate verification failed');
  });
  it('rejects the old unbound payload and duplicate JSON fields', () => {
    const { approvedHeadRef: _ref, ...old } = payload();
    expect(run('selector', { ...old, prNumber: 2045, handle: 'pr-2045' }).status).not.toBe(0);
    expect(run('selector', JSON.stringify(payload()).replace('{', '{"prNumber":2045,')).status).not.toBe(0);
    expect(run('selector', 'not-json').status).not.toBe(0);
  });
  it('admits only a fresh labeled same-repository event with exact approved head identity', () => {
    expect(run('admit').status).toBe(0);
    for (const changed of [{ action: 'synchronize' }, { label: { name: 'ready-for-ci' } },
      { pull_request: { ...event.pull_request, number: 0 } },
      { pull_request: { ...event.pull_request, number: 1_000_000_000 } },
      { pull_request: { ...event.pull_request, number: '2348' } },
      { pull_request: { ...event.pull_request, state: 'closed' } },
      { pull_request: { ...event.pull_request, head: { ...event.pull_request.head, sha: 'b'.repeat(40) } } },
      { pull_request: { ...event.pull_request, head: { ...event.pull_request.head, ref: 'other-branch' } } },
      { pull_request: { ...event.pull_request, head: { ...event.pull_request.head, repo: { full_name: 'fork/matrix-os' } } } }]) {
      expect(run('admit', payload(), { ...event, ...changed }).status).not.toBe(0);
    }
  });
  it('rechecks current PR number, open state, label, repository, branch and SHA', () => {
    expect(run('current').status).toBe(0);
    for (const changed of [{ number: 2347 }, { state: 'closed' }, { labels: [] },
      { head: { ...event.pull_request.head, sha: 'b'.repeat(40) } },
      { head: { ...event.pull_request.head, ref: 'other-branch' } },
      { head: { ...event.pull_request.head, repo: { full_name: 'fork/matrix-os' } } }]) {
      expect(run('current', payload(), event, { ...event.pull_request, ...changed }).status).not.toBe(0);
    }
  });

});
