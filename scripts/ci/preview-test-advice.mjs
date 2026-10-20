import { pages, request, upsertComment } from "./preview-review-api.mjs";
import { needsDesktop } from "./preview-review-model.mjs";
const SHA = /^[a-f0-9]{40}$/;
const WEB = ["Web Desktop", "Web Canvas", "Web Mobile"];
const ELECTRON = "Electron Desktop (macOS arm64/x64, Linux x64, Windows x64 unsigned preview)";
const NATIVE = "Native Mobile (iOS and Android)";
const CLI = "CLI (Linux, macOS and Windows)";
const owned = (pr) =>
  pr.labels.some((l) => ["preview", "preview-platform"].includes(l.name));
// Octokit wraps HTTP, transport and request timeout failures as HttpError.
// Status alone must not turn controller defects into apparently valid advice.
const githubReadFailure = (error) =>
  error instanceof Error && error.name === "HttpError" &&
  Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;

// Advisory metadata rules only. A path match never establishes test coverage.
export function classifyPreviewTests(files, complete = true) {
  const surfaces = new Set();
  const reasons = new Set();
  let preview = false,
    platform = false,
    manual = !complete;
  for (const file of files.slice(0, 3000)) {
    if (!file || typeof file.filename !== "string") {
      manual = true;
      continue;
    }
    for (const path of [file.filename, file.previous_filename].filter(
      Boolean,
    )) {
      if (typeof path !== "string" || path.length > 1024) {
        manual = true;
        continue;
      }
      if (
        /^(docs\/|specs\/|tests\/)|(^|\/)(__tests__\/|[^/]+\.(test|spec)\.[cm]?[jt]sx?$)|^(README|CHANGELOG|CONTRIBUTING|AGENTS|CLAUDE)\.md$/.test(
          path,
        )
      )
        continue;
      if (/^packages\/(contracts|gateway|kernel|proxy|postgres|observability)\//.test(path) ||
          ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(path)) {
        WEB.forEach((surface) => surfaces.add(surface));
        surfaces.add(ELECTRON);
        surfaces.add(NATIVE);
        surfaces.add(CLI);
        manual = true;
        reasons.add("Shared contracts, dependencies or runtime changes need client compatibility scenarios selected by an agent or reviewer; path rules cannot prove which clients are unaffected.");
      }
      if (/^(packages\/(sync-client|cli)\/|bin\/)/.test(path)) {
        surfaces.add(CLI);
        manual = true;
        reasons.add("CLI installation, authentication and protocol scenarios need separate qualification; this preview does not publish CLI binaries.");
      }
      if (/^\.github\/workflows\/desktop-(build|release)\.yml$/.test(path)) {
        surfaces.add("Windows build (existing protected checks)");
        reasons.add("Retain protected Windows build and signing qualification for shared builder changes. Windows preview installers are unsigned and do not qualify protected release signing.");
      }
      if (path.startsWith("packages/platform/")) {
        platform = true;
        surfaces.add("Platform API (isolated staging)");
        reasons.add(
          "Platform changes need their own API qualification; a runtime VPS cannot prove them.",
        );
      } else if (path.startsWith("apps/mobile/")) {
        surfaces.add(NATIVE);
        reasons.add(
          "Native Mobile changes require both native targets; runtime previews do not build native apps.",
        );
      } else if (
        needsDesktop([path]) ||
        /^\.github\/workflows\/(desktop-build|desktop-release|preview-desktop)\.yml$/.test(
          path,
        )
      ) {
        preview = true;
        surfaces.add(ELECTRON);
        WEB.forEach((s) => surfaces.add(s));
        reasons.add(
          "Desktop or shared UI inputs need matching Electron downloads and Web presentation checks.",
        );
      } else if (path.startsWith("shell/")) {
        preview = true;
        WEB.forEach((s) => surfaces.add(s));
        reasons.add(
          "Web presentation changes need browser interaction checks.",
        );
      } else if (/^scripts\/ci\/preview-|^\.github\/workflows\/preview-/.test(path)) {
        preview = true;
        manual = true;
        surfaces.add("Preview orchestration");
        reasons.add("Preview controllers need live exact-head admission, build status, expiry and cleanup scenarios after reviewed Main activation; unit tests do not prove deployment.");
      } else if (
        /^(packages\/(gateway|kernel|proxy|postgres|observability)\/|home\/|distro\/)/.test(
          path,
        )
      ) {
        preview = true;
        surfaces.add("Runtime/API");
        reasons.add(
          "Runtime changes need the exact-head VPS plus API behavior checks.",
        );
      } else {
        manual = true;
        reasons.add(
          "Unclassified build, tooling, dependency, or infrastructure inputs need manual test selection.",
        );
      }
    }
  }
  if (files.length > 3000) {
    complete = false;
    manual = true;
  }
  return {
    preview,
    platform,
    manual,
    complete,
    surfaces: [...surfaces],
    reasons: [...reasons],
  };
}

async function changedFiles(github, repo, pr) {
  if (pr.base.ref !== "main") {
    const { data: branch } = await github.rest.repos.getBranch({
      ...repo,
      branch: "main",
      request,
    });
    if (!SHA.test(branch.commit.sha))
      throw new Error("Main source unavailable");
    // Compare's file list is capped at 300 and is returned only on page one.
    // Reaching that cap is unknown, even when commit pagination has more pages.
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      ...repo,
      basehead: `${branch.commit.sha}...${pr.head.sha}`,
      per_page: 100,
      page: 1,
      request,
    });
    return {
      files: data.files ?? [],
      complete: Array.isArray(data.files) && data.files.length < 300,
      scope: `cumulative main ${branch.commit.sha} to PR head`,
    };
  }
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const { data } = await github.rest.pulls.listFiles({
      ...repo,
      pull_number: pr.number,
      per_page: 100,
      page,
      request,
    });
    if (!Array.isArray(data)) throw new Error("PR file inventory unavailable");
    files.push(...data);
    if (data.length < 100)
      return {
        files,
        complete: files.length === pr.changed_files,
        scope: "PR diff against main",
      };
  }
  return {
    files,
    complete: false,
    scope: "PR diff against main (pagination limit)",
  };
}

export async function advisePreviewTests(github, repo, number) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error("Invalid PR");
  const { data: pr } = await github.rest.pulls.get({
    ...repo,
    pull_number: number,
    request,
  });
  if (pr.state !== "open" || owned(pr)) return;
  if (!SHA.test(pr.head.sha)) throw new Error("PR source unavailable");
  let diff;
  try {
    diff = await changedFiles(github, repo, pr);
  } catch (error) {
    if (!githubReadFailure(error)) throw error;
    console.warn(
      "Preview advice file inventory unavailable",
      error.status,
    );
    diff = { files: [], complete: false, scope: "unavailable" };
  }
  const advice = classifyPreviewTests(diff.files, diff.complete);
  const selection = advice.preview
    ? "Suggested: `preview` for the exact-head runtime"
    : advice.manual
      ? "Preview selection unknown; an agent or reviewer must select the affected scenarios"
      : "No runtime `preview` suggested by the classified paths";
  const body = [
    "<!-- matrix-preview-review-v1 -->",
    "**PR test advice (advisory only)**",
    "",
    `Source: \`${pr.head.sha}\`. Scope: ${diff.scope}.`,
    "",
    `${selection}${advice.manual ? "; manual review required before deciding" : ""}.`,
    ...(advice.platform
      ? [
          "Also required: `preview-platform` and isolated Platform API qualification. Ordinary runtime previews do not test the platform control plane.",
        ]
      : []),
    `Surfaces: ${advice.surfaces.length ? advice.surfaces.join("; ") : "no product surface identified"}.`,
    ...advice.reasons.map((reason) => `- ${reason}`),
    ...(!advice.complete
      ? [
          "- File inventory incomplete; no negative preview recommendation is reliable.",
        ]
      : []),
    "",
    "No live evidence has been inspected. Suggested surfaces still need scenario-specific tests, captures, and human review. Native Mobile builds and platform qualification are separate from runtime preview downloads.",
    "Deterministic path rules; no semantic AI review, approval, labels, deployments, or CI check changes. All existing checks remain required.",
  ].join("\n");
  const { data: fresh } = await github.rest.pulls.get({
    ...repo,
    pull_number: number,
    request,
  });
  if (fresh.state !== "open" || fresh.head.sha !== pr.head.sha || owned(fresh))
    return;
  await upsertComment(github, repo, number, body);
  return advice;
}


// Recover per-PR events coalesced by the shared controller lock. Re-read each
// live head/label before publishing; this sweep cannot allocate a preview.
export async function sweepPreviewTestAdvice(github, repo, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid advice sweep time");
  const rows = await pages(github.rest.pulls.list, {
    ...repo, state: "open", sort: "created", direction: "asc",
  });
  if (rows.length > 5000 || rows.some(row => !Number.isSafeInteger(row?.number)
      || row.number < 1 || !["open", "closed"].includes(row.state)))
    throw new Error("PR inventory unavailable");
  const numbers = [];
  for (const row of rows) if (row.state === "open" && !numbers.includes(row.number)) numbers.push(row.number);
  numbers.sort((a, b) => a - b);
  if (!numbers.length) return { considered: 0, checked: [] };
  const start = (Math.floor(now / 300000) * 8) % numbers.length;
  const checked = Array.from({ length: Math.min(8, numbers.length) }, (_, index) => numbers[(start + index) % numbers.length]);
  let failed = false;
  for (const number of checked) {
    try {
      await advisePreviewTests(github, repo, number);
    } catch (error) {
      failed = true;
      console.warn("Preview advice refresh failed", number, error instanceof Error ? error.name : "UnknownError");
    }
  }
  if (failed) throw new Error("Advice sweep incomplete");
  return { considered: numbers.length, checked };
}
