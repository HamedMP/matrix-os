/** Plain snippets: markdown markup dropped from stored text, with highlights and span starts mapped onto the result. */
import { describe, expect, it } from "vitest";
import { BRAIN_SEARCH_SNIPPET_MAX_CHARS } from "../../packages/gateway/src/brain/contracts.js";
import { parseBrainSearchTerms } from "../../packages/gateway/src/brain/search/query.js";
import { brainSearchPatterns, chunkBrainSnippet, pickBrainSnippet } from "../../packages/gateway/src/brain/search/snippet.js";
import { brainPlainIndex, brainPlainText } from "../../packages/gateway/src/brain/search/snippet-plain.js";
import { chunkBrainBody } from "../../packages/gateway/src/brain/search/vector.js";

const patterns = (q: string) => brainSearchPatterns(parseBrainSearchTerms(q).terms);
const plain = (text: string) => brainPlainText(text).text;
const slices = (text: string, ranges: readonly (readonly [number, number])[]) => ranges.map(([a, b]) => text.slice(a, b));
const body = (lines: readonly string[], sha: string, committed: string, pr: number, paths: number) =>
  `${lines.join("\n")}\n\nCommit: ${sha}\nAuthor: Matrix Dev\nCommitted: ${committed}\nPull request: #${pr}\nChanged paths: ${paths}`;
const ROBOT = "\u{1F916}";

// Real squash-merge bodies from this repository, stored the way the git source stores them (message, then footer).
const PR_2041 = body([
  "## Summary",
  "",
  "Two gateway app-runtime tests fail intermittently in the `Unit Tests` shards on PRs that don't touch app-runtime. Both have a root cause in the product code, not just in the tests:",
  "",
  "1. **Build timeouts left the build running.** `BuildOrchestrator` handed an `AbortSignal` to `spawn(\"sh\", [\"-c\", cmd])`. When the signal aborts, Node sends SIGTERM to the `sh` wrapper only and emits `error` straight away. The orchestrator then reported `timeout` while `pnpm install`/`vite build` (grandchildren of the gateway) kept running as orphans and writing into the app directory. It had also released the slug mutex and the concurrency slot, so a retry could start a second build in the same directory while the first was still writing to it.",
  "2. **App ports overlapped the kernel's ephemeral port range.** `PortPool` allocated from 40000-49999. That range is inside Linux's `net.ipv4.ip_local_port_range` (default 32768-60999), which the kernel uses for the local side of outbound connections. If any outbound socket on the machine held the port, the app server died with `EADDRINUSE`, and `ProcessManager` reported `exited during startup (code=1)`.",
  "",
  "### Changes",
  "",
  "- `build-orchestrator.ts`: the build now spawns `detached` (its own process group). On timeout it SIGKILLs the whole group and resolves only once `kill(-pgid, 0)` returns `ESRCH`. That wait is capped at 5s, and it logs a warning if the group outlives the cap. After a timeout, `error` and `close` events are ignored.",
  "- `port-pool.ts`: new `APP_PORT_RANGE = 20000-29999`, which sits below the ephemeral range. It is the `PortPool` default and is used by `app-runtime-routes.ts`. Spec 063 is updated to match.",
  "- Tests: new `tests/gateway/app-runtime/test-ports.ts` gives each spawning test file its own port slice in 30000-31900. The slices don't overlap, they sit below the ephemeral range, and they stay out of the production range. Before this, the per-test bases in `process-manager.test.ts` grew from 41000 into the 43000-43100 range that `app-runtime-phase2.test.ts` also used.",
  "",
  "## Root cause evidence",
  "",
  "- CI history: I grepped the logs of all 1375 failed `Unit Tests` jobs from the last 1000 failed `ci.yml` runs, going back to 2026-04-25. App-runtime showed up in 9 of them. Adding the two failures that prompted this PR (one push to `main` and PR #2002) gives 11, all on branches that don't touch app-runtime:",
  "  - 5 x `enforces build timeout via AbortSignal`, each failing with `ENOTEMPTY: directory not empty, rmdir '/tmp/matrix-os-build-orch-*'`. This is the `afterEach` `rm -rf` losing a race against the orphaned `pnpm install`.",
  "  - 6 x `exited during startup (code=1, signal=null)`, across four different tests and port ranges (the 45000 eviction pool, the 41xxx per-test pools and phase2's 43xxx pool). That spread points to random collisions rather than one fixed conflicting port.",
  "- Local reproduction of the orphan: a new test uses `install: \"sleep 30 & echo $! > grandchild.pid; wait\"` with a 1s timeout. Before the fix it failed and `sleep 30` was still alive afterwards. It passes after the fix.",
  "- Local reproduction of the port collision: I held local port 45000 with an outbound TCP socket that had no `SO_REUSEADDR`, which is how a kernel-assigned ephemeral port looks. `evicts LRU process when slot cap is reached` then failed with exactly the CI error: `SpawnError: App \"app-a\" exited during startup (code=1, signal=null)`.",
  "",
  "## Tests",
  "",
  "- New: `kills the whole build process tree before resolving a timeout` (build-orchestrator) and `keeps the app port range below the Linux ephemeral port range` (port-pool).",
  "- Repeat runs: I ran `build-orchestrator`, `process-manager`, `dispatcher` and `app-runtime-phase2` together 30 times in a row on an 8-core Linux host, with 4 extra CPU-burner processes keeping it heavily loaded. Result: 30/30 green, 0 failures.",
  "- `bun run typecheck`: pass. `bun run check:patterns`: 0 violations; none of the existing warnings are in the changed files.",
  "",
  "## Invariants",
  "",
  "- **Source of truth**: the OS process table. A build timeout is reported only after the build's process group no longer exists, or after the bounded 5s wait, which logs a warning. `PortPool` is still the in-memory owner of app port leases.",
  "- **Lock/transaction scope**: the per-slug build mutex and the concurrency semaphore now stay held until the timed-out process group is gone. That adds at most 5s, and only on the timeout path.",
  "- **Acceptable orphan states**: a build step that calls `setsid()` to leave its process group can still outlive a timeout. The bounded wait and the warning log cover a group that can't be reaped. Grandchild processes are no longer orphaned in the normal case.",
  "- **Auth source of truth**: unchanged. There are no auth changes.",
  "- **Deferred scope**: `ProcessManager` doesn't probe or retry a port another listener already holds inside 20000-29999. The ephemeral-port class of collision is gone, but a user service listening in that range would still fail app startup. The range change takes effect on existing VPSes at the next gateway restart. App ports are loopback-only and are never persisted.",
  "",
  "## Surface matrix",
  "",
  "No user-visible UI change. This is gateway process lifecycle only.",
  "",
  "| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |",
  "| --- | --- | --- | --- | --- | --- |",
  "| Web Canvas | N/A | N/A | N/A | N/A | N/A |",
  "| Web Desktop | N/A | N/A | N/A | N/A | N/A |",
  "| Electron Desktop | N/A | N/A | N/A | N/A | N/A |",
  "| Web Mobile | N/A | N/A | N/A | N/A | N/A |",
  "| Native Mobile | N/A | N/A | N/A | N/A | N/A |",
  "",
  "N/A rationale: this is a backend-only change to how the gateway spawns processes and allocates ports, with no renderer involvement.",
  "",
  `${ROBOT} Generated with [Claude Code](https://claude.com/claude-code)`,
], "3f4ec7b90c158d1110aec68d1d49636d9c61f21b", "2026-09-30T17:23:19+02:00", 2041, 12);

const PR_2019 = body([
  "## Restore the exact Codex provider contract gate",
  "",
  "The independent Codex verification workflow began failing on Spec 535 PRs because npm published `@openai/codex` 0.158.0 while the repository allowed only through 0.157.1. This PR qualifies the exact 0.158.0 wire schemas and keeps the fail-closed version gate.",
  "",
  "### Evidence and change",
  "",
  "- The tagged `rust-v0.158.0` `codex-rs/exec/src/exec_events.rs` is byte-identical to the reviewed 0.157.1 fixture (`dafa872d...d0e5`). The exact tagged source is checked in as a new fixture.",
  "- The installed `codex-cli 0.158.0` generated app-server schema hashes to `aa5cb3fb...a709dcd0f` on Linux. The [macOS verification job](https://github.com/HamedMP/matrix-os/actions/runs/36473576434/job/109101591845) printed the same digest and the same `turn/completed` digest.",
  "- Of Matrix's required protocol method digests, only `turn/completed` changed (`873327cc...5972`). The schema adds `flexUnavailable` to its error-code enum. The runner reads the bounded turn status and treats other turn fields as passthrough; this new error code remains a generic failed turn. Other global schema changes concern environment and plugin fields that the Matrix provider does not consume.",
  "- Adds the exact compressed schema fixture and changes the version/digest checks and focused tests. The runtime's installed default version remains separately pinned.",
  "",
  "### Invariants",
  "",
  "| Concern | Rule |",
  "| --- | --- |",
  "| Source of truth | OpenAI's tagged exec source and the published 0.158.0 CLI-generated schema; hashes are checked against exact bytes on each supported CI target. |",
  "| Lock or transaction scope | None; this changes static compatibility records and tests only. |",
  "| Acceptable orphan state | None; an unknown version or changed schema still fails the gate. |",
  "| Auth source | Existing Codex runtime authentication is unchanged. No credentials or native sessions were exercised by this PR. |",
  "| Deferred scope | Native runtime default upgrades and unrelated protocol capabilities require their own qualification. |",
  "",
  "### Validation",
  "",
  "- `node scripts/check-codex-exec-contract.mjs 0.158.0 ...` passed against the exact fixture and generated schema.",
  "- Focused contract tests: 23 passed across the checker, app-server status, and exec event suites.",
  "- `git diff --check` passed. The published-version job on both Linux and macOS remains the CI authority for its current package bytes.",
  "",
  "This PR is a draft pending current-head Greptile 5/5, CI, and owner merge approval. It unblocks the provider-contract gate for the Spec 535 PRs after merge.",
], "583850b2e99e7cfd92a426d585704026ecfa922c", "2026-09-29T08:12:59+01:00", 2019, 7);

const PR_1535_LINES = [
  "## Summary",
  "",
  "- keep the Chat composer mounted and focused across background canonical-stream synchronization",
  "- store bounded, serializable drafts per Chat/new-Chat context, including project and reference tokens",
  "",
  "Linear: [OM-204](https://linear.app/matrix-os/issue/OM-204), [OM-205](https://linear.app/matrix-os/issue/OM-205), [OM-206](https://linear.app/matrix-os/issue/OM-206)",
  "",
  "## Manual validation",
  "",
  "- [x] Human Review confirmed the original composer, draft, casing, Copy, and Wrap fixes and exposed the long-line containment follow-up",
  "- [x] Exact-head Electron Desktop confirms an unwrapped 300+ character code line stays inside the Chat message and scrolls only within the code card",
  "",
  "## Visual evidence",
  "",
  "Captured from Electron Desktop at product commit `ce72794faa0711986072fc2cd5a7f70e0097fb83` (the following commit only adds this evidence asset).",
  "",
  "![Exact-head Electron Desktop Chat code containment](https://raw.githubusercontent.com/HamedMP/matrix-os/4b583eedb4e8daf1d62731709997773ff9cda41b/docs/pr-evidence/pr-1535-chat-code-containment.png)",
];
const PR_1535 = body(PR_1535_LINES, "287ff5b837e115ae723e65ddc52cf74d0fb37f7e", "2026-09-04T01:12:03+08:00", 1535, 18);

const PR_1784 = body([
  "## Scope",
  "",
  "- `specs/124-organization-collaboration/research.md` \u2014 \"S00 \u2014 Baseline receipt (T001, T005)\": seam table with file:line citations; provider custody inventory",
  "- `specs/124-organization-collaboration/evidence/{providers,direct,S00-receipt}.md`",
  "",
  "Path note: tasks.md names `tests/integration/*.test.ts`; the unit config includes `tests/**/*.test.ts` and the integration config includes only `*.integration.ts`, so the harnesses use the `.integration.ts` suffix to stay off the unit run.",
  "",
  "## Verification",
  "",
  "```",
  "pnpm exec vitest run --config vitest.integration.config.ts tests/integration",
  "  Test Files  3 passed (3)",
  "       Tests  8 passed | 19 skipped (27)   # 19 skipped = unrun live probes, each named with its missing fixture",
  "bun run typecheck        # pass",
  "```",
  "",
  `${ROBOT} Generated with [Claude Code](https://claude.com/claude-code)`,
], "fb8b2134601b61907fabb07c23e857aecc7aa0fe", "2026-09-20T23:56:24+02:00", 1784, 8);

const FIXTURES = [PR_2041, PR_2019, PR_1535, PR_1784];
/** Markup that must not survive: code ticks, link syntax, task boxes, line breaks, runs of spaces, URLs. */
const MARKUP = /`|\]\(|\[x\]|\n|\s{2}|https?:\/\//;
/** Emphasis, heading hashes and table pipes, which code text may hold as written (PR_1784 has both). */
const PROSE_MARKUP = /\*\*|__|(^|\s)#{1,6}\s|\s\|\s/;

describe("brain plain text", () => {
  it("drops markdown markup and keeps the words", () => {
    expect(plain("## Summary ##\n\nSome **bold**, __strong__, *em*, _em_ and ~~old~~ text."))
      .toBe("Summary Some bold, strong, em, em and old text.");
    expect(plain("Run `pnpm exec vitest` or ``a ` tick`` now")).toBe("Run pnpm exec vitest or a ` tick now");
    expect(plain("See [the **docs**](https://example.com/docs \"Docs\") and ![a chart](https://example.com/c.png)."))
      .toBe("See the docs and a chart.");
    expect(plain("Ref <https://example.com/raw> and [a ref][1], [b][].\n\n[1]: https://example.com/ref\n[b]: /b \"B\""))
      .toBe("Ref https://example.com/raw and a ref, b.");
    expect(plain("- [x] Done\n* bullet\n+ plus\n  - nested\n1. First")).toBe("Done bullet plus nested 1. First");
    expect(plain("> quoted **text**\n> > deeper")).toBe("quoted text deeper");
    expect(plain("Title\n=====\nBody\n\n---\n\n* * *\nEnd")).toBe("Title Body End");
    expect(plain("| Surface | UI |\n| --- | :-: |\n| Web Canvas | `a|b` |")).toBe("Surface UI Web Canvas a|b");
    expect(plain("  a\r\n\r\n\tb  ")).toBe("a b");
    expect(plain("line\\\nbreak\\")).toBe("line break\\");
    expect(plain("<sub>tiny</sub> and <kbd>Ctrl</kbd>+<kbd>C</kbd>, Co-authored-by: A <a@example.com>"))
      .toBe("tiny and Ctrl+C, Co-authored-by: A a@example.com");
    expect(plain("")).toBe("");
  });

  it("keeps text that only looks like markup", () => {
    const literal = "brain_why, GIT_MAX_SYNCS and a_b_c; 5 * 3 * 2; specs/*/spec.md; # C# and #1765; ~5s; "
      + "matrix[i][j], f(x), [WIP], 2 < 3 > 1, Map<string, number> and <home>/system";
    expect(plain(literal)).toBe(literal);
    expect(plain("# C#")).toBe("C#");
    expect(plain("__init__ and **bold**: done")).toBe("init and bold: done");
  });

  it("keeps fenced code as written and drops HTML, comments, escapes and entities", () => {
    expect(plain("```ts\nconst a = **b**; // [x](y)\n```\nafter")).toBe("const a = **b**; // [x](y) after");
    expect(plain("~~~\n## not a heading\n~~~")).toBe("## not a heading");
    expect(plain("a <!-- hidden\n- **Source of truth:** template\n--> b <!-- inline --> c")).toBe("a b c");
    expect(plain("open <!-- never closed\nstill hidden")).toBe("open");
    expect(plain("<details><summary>More</summary>\nBody<br>line</details> <b>bold</b>")).toBe("More Body line bold");
    expect(plain("\\*not em\\*, 1\\. and \\[x\\](y) &amp; &lt;b&gt; &#x1F600; &#65;"))
      .toBe("*not em*, 1. and [x](y) & <b> \u{1F600} A");
  });

  it("maps every plain unit to its stored index and span starts back onto the plain text", () => {
    for (const text of FIXTURES) {
      const { text: out, sources } = brainPlainText(text);
      expect([sources.length, sources[out.length]]).toEqual([out.length + 1, text.length]);
      const bad: number[] = [];
      for (let i = 0; i < out.length; i += 1) {
        if (i > 0 && sources[i]! < sources[i - 1]!) bad.push(i);
        if (out[i] !== " " && text[sources[i]!] !== out[i]) bad.push(i);
      }
      expect(bad).toEqual([]);
      expect(out).not.toMatch(MARKUP);
      expect(out.isWellFormed()).toBe(true);
      if (text !== PR_1784) expect(out).not.toMatch(PROSE_MARKUP);
    }
    const parsed = brainPlainText(PR_2041);
    const at = brainPlainIndex(parsed, PR_2041.indexOf("## Root cause evidence"));
    expect(parsed.text.slice(at).startsWith("Root cause evidence CI history: I grepped")).toBe(true);
    expect([brainPlainIndex(parsed, -5), brainPlainIndex(parsed, 1e9)]).toEqual([0, parsed.text.length]);
  });

  it("reads real pull request bodies as plain sentences", () => {
    expect(plain(PR_1535)).toBe([
      "Summary keep the Chat composer mounted and focused across background canonical-stream synchronization",
      "store bounded, serializable drafts per Chat/new-Chat context, including project and reference tokens",
      "Linear: OM-204, OM-205, OM-206 Manual validation Human Review confirmed the original composer, draft, casing,",
      "Copy, and Wrap fixes and exposed the long-line containment follow-up Exact-head Electron Desktop confirms an",
      "unwrapped 300+ character code line stays inside the Chat message and scrolls only within the code card",
      "Visual evidence Captured from Electron Desktop at product commit ce72794faa0711986072fc2cd5a7f70e0097fb83 (the",
      "following commit only adds this evidence asset). Exact-head Electron Desktop Chat code containment",
      "Commit: 287ff5b837e115ae723e65ddc52cf74d0fb37f7e Author: Matrix Dev Committed: 2026-09-04T01:12:03+08:00",
      "Pull request: #1535 Changed paths: 18",
    ].join(" "));
    const text = plain(PR_2041);
    for (const part of ["Summary Two gateway app-runtime tests fail intermittently in the Unit Tests shards",
      "1. Build timeouts left the build running. BuildOrchestrator handed an AbortSignal to spawn(\"sh\", [\"-c\", cmd]).",
      "Source of truth: the OS process table.", "Surface UI Behavior State/recovery Automated tests Real evidence",
      "Web Canvas N/A N/A N/A N/A N/A Web Desktop", `${ROBOT} Generated with Claude Code Commit: 3f4ec7b90c`]) {
      expect(text).toContain(part);
    }
    expect(plain(PR_2019)).toContain("on Linux. The macOS verification job printed the same digest and the same "
      + "turn/completed digest.");
    expect(plain(PR_1784)).toContain("Path note: tasks.md names tests/integration/*.test.ts; the unit config includes "
      + "tests/**/*.test.ts and");
    expect(plain(PR_1784)).toContain("Verification pnpm exec vitest run --config vitest.integration.config.ts "
      + "tests/integration Test Files 3 passed (3) Tests 8 passed | 19 skipped (27) # 19 skipped = unrun");
  });
});

describe("plain snippets", () => {
  const snippet = (text: string, q: string) => pickBrainSnippet([{ field: "body", text }], patterns(q));

  it("highlights the matched words of the plain text inside the length bound", () => {
    const cases: [string, string, string[]][] = [
      [PR_2041, "\"BuildOrchestrator handed an AbortSignal\"", ["BuildOrchestrator handed an AbortSignal"]],
      [PR_2041, "\"build timeouts left the build running\"", ["Build timeouts left the build running"]],
      [PR_2019, "\"macOS verification job\"", ["macOS verification job"]],
      [PR_1535, "OM", ["OM", "OM", "OM"]],
      [PR_1535, "\"exact-head electron\"", ["Exact-head Electron"]],
      [PR_1784, "skipped", ["skipped", "skipped"]],
    ];
    for (const [text, q, words] of cases) {
      const view = snippet(text, q);
      expect(slices(view.text, view.highlights)).toEqual(words);
      expect(view.text.length).toBeLessThanOrEqual(BRAIN_SEARCH_SNIPPET_MAX_CHARS);
      expect(view.text).not.toMatch(MARKUP);
      if (text !== PR_1784) expect(view.text).not.toMatch(PROSE_MARKUP);
      expect(view.text.isWellFormed()).toBe(true);
    }
    const ephemeral = snippet(PR_2041, "ephemeral");
    expect(ephemeral.highlights.length).toBeGreaterThan(0);
    expect(slices(ephemeral.text, ephemeral.highlights).every((word) => word.toLowerCase() === "ephemeral")).toBe(true);
    expect([ephemeral.truncatedStart, ephemeral.truncatedEnd]).toEqual([true, true]);
  });

  it("shows no highlight for words only a dropped URL held", () => {
    const fields = [{ field: "body", text: PR_1535 }, { field: "title", text: "fix(desktop): preserve `Chat` state" }] as const;
    const view = pickBrainSnippet(fields, patterns("githubusercontent"));
    expect(view).toMatchObject({ field: "body", highlights: [], truncatedStart: false, truncatedEnd: true });
    expect(view.text.startsWith("Summary keep the Chat composer")).toBe(true);
    expect(pickBrainSnippet(fields, patterns("state"))).toMatchObject({ field: "title",
      text: "fix(desktop): preserve Chat state", highlights: [[28, 33]] });
  });

  it("strips claim quotes and labels too", () => {
    const view = pickBrainSnippet([{ field: "statement", text: "the OS process table." },
      { field: "quote", text: "- **Source of truth**: the OS process table." }], patterns("source"));
    expect(view).toEqual({ field: "quote", text: "Source of truth: the OS process table.", highlights: [[0, 6]],
      truncatedStart: false, truncatedEnd: false });
  });

  it("ends at the real end of a body and never splits a surrogate pair", () => {
    const tail = snippet(PR_2041, "generated");
    expect(tail.text.endsWith(`${ROBOT} Generated with Claude Code Commit: 3f4ec7b90c158d1110aec68d1d49636d9c61f21b `
      + "Author: Matrix Dev Committed: 2026-09-30T17:23:19+02:00 Pull request: #2041 Changed paths: 12")).toBe(true);
    expect([tail.truncatedEnd, slices(tail.text, tail.highlights)]).toEqual([false, ["Generated"]]);
    const emoji = "\u{1F600}";
    for (const text of [`- **${emoji.repeat(150)}** alpha!`, `ab **${emoji.repeat(151)}** alpha!`,
      `## ${emoji.repeat(300)}\n\n**alpha** ${emoji.repeat(300)}`]) {
      const view = snippet(text, "alpha");
      expect(view.text.isWellFormed()).toBe(true);
      expect(view.text.length).toBeLessThanOrEqual(BRAIN_SEARCH_SNIPPET_MAX_CHARS);
      expect(slices(view.text, view.highlights)).toEqual(["alpha"]);
    }
  });

  it("starts a chunk snippet at the plain position of the chunk's stored span start", () => {
    const start = PR_2041.indexOf("## Root cause evidence");
    const chunk = chunkBrainSnippet(PR_2041, start, patterns("grepped"));
    expect(chunk.text.startsWith("Root cause evidence CI history: I grepped the logs")).toBe(true);
    expect([chunk.truncatedStart, chunk.truncatedEnd, slices(chunk.text, chunk.highlights)])
      .toEqual([true, true, ["grepped"]]);
    for (const text of FIXTURES) {
      const parsed = brainPlainText(text);
      for (const span of chunkBrainBody(text)) {
        const view = chunkBrainSnippet(text, span.spanStart, []);
        expect(parsed.text.startsWith(view.text, brainPlainIndex(parsed, span.spanStart))).toBe(true);
        expect(view.text.length).toBeLessThanOrEqual(BRAIN_SEARCH_SNIPPET_MAX_CHARS);
      }
    }
  });

  it("stays linear on hostile markup", () => {
    const hostile = ["[a](".repeat(50_000), "[".repeat(100_000) + "]".repeat(100_000), "<!--".repeat(50_000),
      `<!--${"\nx".repeat(100_000)}`, "*a_".repeat(70_000), "`a``".repeat(50_000), "\\".repeat(200_000),
      "<details ".repeat(25_000), "&#".repeat(100_000), "> ".repeat(100_000), `${" ".repeat(200_000)}x`,
      `[a]: ${"x".repeat(200_000)} y`, "[a]([a](".repeat(30_000) + ")".repeat(60_000), `${"- ".repeat(100_000)}x`,
      // Near rules: a long run of spaces before the last character once backtracked quadratically.
      `---${" ".repeat(200_000)}x`, `* * *${" \t".repeat(100_000)}x`, `===${" ".repeat(200_000)}x`];
    for (const text of hostile) {
      const parsed = brainPlainText(text);
      expect(parsed.sources).toHaveLength(parsed.text.length + 1);
      expect(snippet(text, "a").text.length).toBeLessThanOrEqual(BRAIN_SEARCH_SNIPPET_MAX_CHARS);
    }
  });
});
