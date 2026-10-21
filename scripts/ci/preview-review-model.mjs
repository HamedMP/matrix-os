// GitHub metadata is the queue; platform Postgres remains machine authority.
export const CAPACITY = 16;
export const TTL_MS = 72 * 60 * 60 * 1000;
export const TASK = "matrix-preview-v1";
export const SHA = /^[a-f0-9]{40}$/;
export const repoName = (repo) => `${repo.owner}/${repo.repo}`.toLowerCase();
export const labeled = (pr) =>
  pr.labels?.some((label) => label.name === "preview");
export const eligible = (pr) =>
  pr.state === "open" &&
  labeled(pr) &&
  !pr.labels?.some((l) => l.name === "preview-collaboration") &&
  pr.head?.repo?.full_name?.toLowerCase() === "hamedmp/matrix-os" &&
  SHA.test(pr.head.sha);
export function ownedLease(row) {
  const p = row.payload;
  return (
    row.task === TASK &&
    row.creator?.login === "github-actions[bot]" &&
    row.creator?.type === "Bot" &&
    p?.schema === TASK &&
    Number.isSafeInteger(p.pr) &&
    p.pr > 0 &&
    SHA.test(p.head) &&
    SHA.test(p.controllerSha) &&
    row.sha === p.head &&
    row.environment === `review-pr-${p.pr}` &&
    Number.isFinite(Date.parse(p.expiresAt))
  );
}
function sharedPreview(row) {
  return (
    row.provisioningClass === "preview" &&
    /^pr-[1-9][0-9]{0,8}$/.test(row.handle) &&
    (row.runtimeSlot === row.handle || row.runtimeSlot === "preview")
  );
}
export const sharedMachine = (row) => sharedPreview(row) && row.deletedAt == null && row.status !== "deleted";
const unknownCleanup = (row) => sharedPreview(row) && !sharedMachine(row) && row.previewDeletionConfirmed !== true;
export const CLEANUP_PREFIX = "Cleanup started: ";
export const cleanupStarted = (row) =>
  row.description?.startsWith(CLEANUP_PREFIX) === true;
export function planQueue({
  requests,
  reservations,
  machines,
  pendingPrs = [],
  owner,
  now = Date.now(),
}) {
  const active = reservations.filter((r) => r.state !== "inactive");
  const reserved = new Set([...active.map((r) => r.payload.pr), ...pendingPrs]);
  const physical = machines.filter((m) => sharedMachine(m) || unknownCleanup(m));
  const cleanupPending = machines.some(unknownCleanup);
  // Different owners can have the same handle. Count their physical machines,
  // while a reservation backed by one physical machine does not count twice.
  const occupied =
    physical.length +
    [...reserved].filter(
      (pr) =>
        !physical.some(
          (m) =>
            sharedMachine(m) && m.handle === `pr-${pr}` &&
            active.some(
              (r) => r.payload.pr === pr && r.payload.owner === m.clerkUserId,
            ),
        ),
    ).length;
  const cleanup = active.filter((r) => {
    const pr = requests.find((p) => p.number === r.payload.pr);
    return (
      cleanupStarted(r) ||
      !pr ||
      !eligible(pr) ||
      pr.head.sha !== r.payload.head ||
      Date.parse(r.payload.expiresAt) <= now
    );
  });
  const candidates = requests
    .filter((p) => eligible(p) && !reserved.has(p.number))
    .sort(
      (a, b) =>
        String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
        a.number - b.number,
    );
  // An unreserved legacy preview already occupies capacity. Adopt only an
  // unambiguous, unexpired physical runtime belonging to the controller owner.
  let available = Math.max(0, CAPACITY - occupied);
  const admit = [],
    waiting = [];
  for (const candidate of candidates) {
    // Unknown tombstones may represent duplicate/ambiguous creates, so pause
    // all new allocations rather than assuming each row is only one server.
    if (cleanupPending) { waiting.push(candidate); continue; }
    const targets = physical.filter((m) => m.handle === `pr-${candidate.number}`);
    const target = targets[0];
    const adopts =
      /^user_[A-Za-z0-9]+$/.test(owner ?? "") &&
      targets.length === 1 &&
      target.clerkUserId === owner &&
      target.status === "running" &&
      Date.parse(target.provisionedAt) <= now &&
      Date.parse(target.provisionedAt) + TTL_MS > now;
    if (adopts || available > 0) {
      admit.push(candidate);
      if (!adopts) available--;
    } else waiting.push(candidate);
  }
  return { occupied, cleanup, admit, waiting, cleanupPending };
}
export function needsDesktop(paths) {
  return paths.some(
    (path) =>
      /^(desktop\/|packages\/(ui|brand|contracts|sync-client)\/|shell\/public\/)/.test(
        path,
      ) ||
      [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "scripts/release/build-source.mjs",
        "scripts/release/desktop-update-fixture-server.mjs",
        "scripts/release/windows-signing-config.mjs",
        "scripts/ci/preview-windows-smoke.ps1",
        ".github/workflows/preview-desktop.yml",
        ".github/workflows/desktop-build.yml",
      ].includes(path),
  );
}
const cell = (value) =>
  String(value ?? "")
    .replace(/[\r\n|`<>\[\]()!*_~\\]/g, " ")
    .slice(0, 120);
export function renderReview({
  pr,
  head,
  status,
  expiresAt,
  web,
  artifacts = [],
  queue = [],
  active = [],
  runs = [],
  platform = false,
  desktop,
  occupied = active.length,
}) {
  const rows = queue
    .slice(0, 100)
    .map(
      (p, i) =>
        `| ${i + 1} | #${p.number} | \`@${cell(p.user?.login)}\` | ${cell(p.title)} |`,
    );
  const slots =
    active
      .slice(0, 100)
      .map((p) => `#${p.pr} (\`@${cell(p.author)}\`)`)
      .join(", ") || "None";
  return (
    `<!-- matrix-preview-review-v1 -->\n**PR preview: ${cell(status)}**\n\n` +
    `- Source: \`${head}\` · @${cell(pr.user?.login)}\n` +
    `- Web Desktop / Web Canvas: ${web ? `[Open preview](${web})` : "Pending; no current-head runtime link yet"}\n` +
    `- Runtime expires: ${expiresAt ?? "Not allocated while queued"}\n` +
    `- Desktop downloads: ${desktop === false ? "Desktop inputs unchanged; no new installer was built. Use your existing desktop app to test this runtime." : artifacts.length ? artifacts.map((a) => `[${cell(a.label)}](${a.url}) (expires ${a.expiresAt})`).join("; ") : "No current-head downloads available yet; see build status below"}\n` +
    runs
      .map((r) => `- [${cell(r.label)}](${r.url}): ${cell(r.state)}\n`)
      .join("") +
    (platform
      ? "- Platform changes require the separate platform-preview path; this runtime does not qualify isolated platform behavior.\n"
      : "") +
    "\nExisting CI, release signing and 15-minute stability checks remain required. Windows preview installers are unsigned; Windows may show an unknown-publisher warning. A preview link does not approve merging. Branch desktop installers replace the normal app.\n" +
    `\n**How to test**\n1. Open the web preview above once available and sign in.\n2. ${desktop === false ? "Open your existing desktop app" : "Download and extract the matching installer above, install it, then open Matrix OS"}; use the computer selector to choose \`pr-${pr.number}\`.\n3. Exercise the affected surfaces and any attached test plan; compare the source commit above before testing. Report the platform and result in this PR.\n` +
    `\n**Shared preview slots: ${occupied}/${CAPACITY}**\n${slots}\n\n**Waiting PRs and authors**\n\n` +
    (rows.length
      ? "| Position | PR | Author | Change |\n|---|---|---|---|\n" +
        rows.join("\n")
      : "No other PRs waiting.") +
    (queue.length > 100
      ? `\n${queue.length - 100} additional PRs waiting; see the preview-labeled PR list.`
      : "") +
    "\n\nMerge/close or remove `preview` to stop owned jobs and release the disposable runtime.\n"
  );
}
