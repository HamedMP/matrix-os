import { createHash } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HandoffApiError, type ChatSelection, type HandoffGateway, type ProviderInstance } from "./gateway-api.js";
import {
  countUnpushedCommits,
  createHandoffBundle,
  inspectRepository,
  snapshotWorkingTree,
  withScratchDir,
  type HandoffBundle,
  type LocalRepository,
  type WorkingTreeSnapshot,
} from "./git-local.js";
import {
  fallbackProjectSlug,
  findMatchingProject,
  githubHttpsUrl,
  remoteBranchName,
  sideBranchName,
  slugBase,
  type MatrixProject,
} from "./project-match.js";
import {
  HANDOFF_STAGE_DIR,
  applySnapshotCommand,
  cleanupCommand,
  integrateCommand,
  parseScriptOutput,
  seedProjectCommand,
  type RemoteCommand,
} from "./remote-scripts.js";

export type HandoffAgent = "codex" | "claude";
export const AGENT_INSTANCE: Record<HandoffAgent, string> = { codex: "codex_default", claude: "claude_code_default" };
const PART_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const MAX_BRIEF_CHARS = 24_000;
const APPROVAL_TOKEN = /^([0-9]{12})\.([a-f0-9]{64})$/;

export class HandoffError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "HandoffError";
  }
}

export interface TranscriptChoice {
  path: string;
  harness: "codex" | "claude";
  bytes: number;
  modifiedMs: number;
}

export interface HandoffInput {
  cwd: string;
  agent: HandoffAgent;
  brief: string | null;
  title?: string;
  history: "auto" | "none" | { path: string; harness: "codex" | "claude" };
  permissionMode?: string;
  model?: string;
  approvalToken?: string;
  gatewayUrl: string;
}

export interface HandoffDeps {
  gateway: HandoffGateway;
  discoverTranscript(root: string): Promise<TranscriptChoice | null>;
  importTranscript(choice: TranscriptChoice, title: string): Promise<{ chatId: string }>;
  now(): Date;
  log(line: string): void;
}

type ProjectPlan =
  | { action: "reuse"; project: MatrixProject }
  | { action: "create_github"; slug: string; url: string }
  | { action: "create_folder"; slug: string };

export interface HandoffPreview {
  repo: LocalRepository;
  branch: string;
  sideBranch: string;
  snapshot: WorkingTreeSnapshot;
  unpushedCommits: number;
  project: ProjectPlan;
  instance: ProviderInstance;
  selection: ChatSelection;
  interactionMode: string;
  permissionMode: string;
  transcript: TranscriptChoice | null;
  title: string;
  message: string;
  uploadId: string;
  approvalToken: string;
}

export interface HandoffResult {
  projectSlug: string;
  branch: string;
  usedSideBranch: boolean;
  executionRoot: { kind: "project"; projectId: string } | { kind: "worktree"; projectId: string; worktreeId: string };
  checkoutPath: string;
  chatId: string;
  transcriptChatId: string | null;
  url: string;
}

function stampOf(date: Date): string {
  return date.toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeTitle(input: string | undefined, fallback: string): string {
  const title = (input ?? fallback).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160);
  return title || "Matrix handoff";
}

export function chooseSelection(instance: ProviderInstance, requestedPermission?: string, requestedModel?: string) {
  const available = instance.models.filter((candidate) => (candidate.availability ?? "available") === "available").map((candidate) => candidate.id);
  if (requestedModel && !available.includes(requestedModel)) {
    throw new HandoffError(`Model must be one of: ${available.join(", ") || "none available"}.`, "invalid_model");
  }
  const model = requestedModel ?? instance.defaultSelection?.model ?? available[0];
  if (!model) throw new HandoffError(`${instance.displayName ?? instance.id} has no available model in Matrix.`, "model_unavailable");
  const interactionModes = instance.supports?.interactionModes ?? [];
  const permissionModes = instance.supports?.permissionModes ?? [];
  const interactionMode = interactionModes.includes("default") ? "default" : interactionModes[0] ?? "default";
  let permissionMode = permissionModes.includes("supervised") ? "supervised" : permissionModes[0] ?? "supervised";
  if (requestedPermission) {
    if (!permissionModes.includes(requestedPermission)) {
      throw new HandoffError(`Permission mode must be one of: ${permissionModes.join(", ") || "supervised"}.`, "invalid_permission_mode");
    }
    permissionMode = requestedPermission;
  }
  const selection: ChatSelection = {
    instanceId: instance.id,
    model,
    ...(instance.defaultSelection?.options?.length ? { options: instance.defaultSelection.options } : {}),
  };
  return { selection, interactionMode, permissionMode };
}

export function readyInstance(instances: ProviderInstance[], agent: HandoffAgent): ProviderInstance {
  const instance = instances.find((candidate) => candidate.id === AGENT_INSTANCE[agent]);
  const name = agent === "codex" ? "Codex" : "Claude Code";
  if (!instance) throw new HandoffError(`${name} is not installed on your Matrix computer.`, "agent_unavailable");
  if (instance.availability !== "available") {
    const command = instance.setupActions.find((action) => action.command)?.command;
    const hint = command ? ` Open a Matrix terminal and run \`${command}\`, then retry.` : " Finish its setup in Matrix Settings, then retry.";
    throw new HandoffError(`${name} is not signed in on your Matrix computer.${hint}`, "agent_not_ready");
  }
  return instance;
}

export function buildMessage(input: {
  brief: string | null;
  repo: LocalRepository;
  branch: string;
  requestedBranch: string;
  snapshot: WorkingTreeSnapshot;
  unpushedCommits: number;
  transcript: { chatId: string } | "pending" | null;
}): string {
  const brief = input.brief?.trim()
    || `Continue the task I was working on locally in ${input.repo.name}. Read the recent commits and the uncommitted changes to understand where it stands.`;
  const lines = [
    brief,
    "",
    "---",
    "Matrix handoff context:",
    `- Repository: ${input.repo.github ? `${input.repo.github.owner}/${input.repo.github.repo}` : input.repo.name}`,
    `- Branch: \`${input.branch}\` at local HEAD \`${input.repo.head.slice(0, 12)}\` (${input.unpushedCommits} commit(s) not on origin)`,
  ];
  if (input.branch !== input.requestedBranch) {
    lines.push(`- \`${input.requestedBranch}\` on Matrix had diverged or had uncommitted work, so this handoff landed on \`${input.branch}\` instead. Reconcile the two only if I ask.`);
  }
  if (input.snapshot.changedPaths.length) {
    lines.push(`- ${input.snapshot.changedPaths.length} uncommitted file change(s) were applied to the checkout as uncommitted changes.`);
  }
  if (input.snapshot.withheldPaths.length) {
    lines.push(`- Withheld secret-looking files (not copied): ${input.snapshot.withheldPaths.slice(0, 20).join(", ")}. Ask me before recreating them.`);
  }
  if (input.transcript && input.transcript !== "pending") {
    lines.push(`- The local agent transcript was imported as a separate private Matrix Chat (${input.transcript.chatId}).`);
  }
  lines.push("- Run `git status` and review the recent log before editing. Ask before destructive or external actions such as pushing.");
  return lines.join("\n");
}

async function splitIntoParts(path: string, bytes: number, outputDir: string): Promise<string[]> {
  const parts: string[] = [];
  const handle = await open(path, "r");
  try {
    for (let offset = 0, index = 0; offset < bytes; offset += PART_BYTES, index += 1) {
      const buffer = Buffer.alloc(Math.min(PART_BYTES, bytes - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const part = join(outputDir, `bundle.part-${String(index).padStart(4, "0")}`);
      const out = await open(part, "wx", 0o600);
      try {
        await out.write(buffer.subarray(0, bytesRead));
      } finally {
        await out.close();
      }
      parts.push(part);
    }
  } finally {
    await handle.close();
  }
  return parts;
}

async function runScript(gateway: HandoffGateway, command: RemoteCommand, step: string): Promise<Record<string, string>> {
  const result = await gateway.run(command);
  const output = parseScriptOutput(result.stdout);
  if (result.exitCode !== 0 || !output.result) {
    throw new HandoffError(`Matrix could not ${step}. Re-run with MATRIX_CLI_DEBUG=1 for details.`, "remote_step_failed");
  }
  return output;
}

async function resolveTranscript(
  history: HandoffInput["history"],
  root: string,
  deps: HandoffDeps,
): Promise<TranscriptChoice | null> {
  if (history === "none") return null;
  if (history === "auto") return await deps.discoverTranscript(root);
  const info = await stat(history.path);
  if (!info.isFile()) throw new HandoffError("The transcript path is not a file.", "invalid_transcript");
  return { path: history.path, harness: history.harness, bytes: info.size, modifiedMs: info.mtimeMs };
}

export async function runHandoff(
  input: HandoffInput,
  deps: HandoffDeps,
  confirm: (preview: HandoffPreview) => Promise<boolean>,
): Promise<{ preview: HandoffPreview; result: HandoffResult | null }> {
  if (input.brief && input.brief.length > MAX_BRIEF_CHARS) {
    throw new HandoffError(`The brief is longer than ${MAX_BRIEF_CHARS} characters; shorten it.`, "brief_too_long");
  }
  const approved = input.approvalToken ? APPROVAL_TOKEN.exec(input.approvalToken) : null;
  if (input.approvalToken && !approved) throw new HandoffError("--approve must be the token printed by the preview.", "invalid_token");

  const repo = await inspectRepository(input.cwd);
  const branch = remoteBranchName(repo.branch, repo.head);
  const stamp = approved?.[1] ?? stampOf(deps.now());
  const sideBranch = sideBranchName(branch, stamp);
  const fallbackSlug = fallbackProjectSlug(repo.name, repo.rootCommit);

  const [projects, instances] = await Promise.all([deps.gateway.listProjects(), deps.gateway.providerCatalog()]);
  const instance = readyInstance(instances, input.agent);
  const { selection, interactionMode, permissionMode } = chooseSelection(instance, input.permissionMode, input.model);
  const match = findMatchingProject(projects, { github: repo.github, fallbackSlug });
  const project: ProjectPlan = match
    ? { action: "reuse", project: match }
    : repo.github
      ? { action: "create_github", slug: slugBase(repo.github.repo), url: githubHttpsUrl(repo.github) }
      : { action: "create_folder", slug: fallbackSlug };

  const transcript = await resolveTranscript(input.history, repo.root, deps);

  return await withScratchDir(async (scratch) => {
    const snapshot = await snapshotWorkingTree(repo, scratch);
    const unpushedCommits = await countUnpushedCommits(repo);
    const title = safeTitle(input.title, `${repo.name} · ${branch}`);
    const scope = {
      version: 1,
      root: repo.root,
      head: repo.head,
      branch,
      snapshot: snapshot.commit,
      withheld: snapshot.withheldPaths,
      project: project.action === "reuse" ? { reuse: project.project.id } : project,
      agent: input.agent,
      selection,
      permissionMode,
      brief: input.brief ?? "",
      title,
      transcript: transcript ? { path: transcript.path, bytes: transcript.bytes, modifiedMs: transcript.modifiedMs } : null,
    };
    const digest = digestOf(scope);
    const preview: HandoffPreview = {
      repo,
      branch,
      sideBranch,
      snapshot,
      unpushedCommits,
      project,
      instance,
      selection,
      interactionMode,
      permissionMode,
      transcript,
      title,
      message: buildMessage({ brief: input.brief, repo, branch, requestedBranch: branch, snapshot, unpushedCommits, transcript: transcript ? "pending" : null }),
      uploadId: `handoff-${stamp}-${digest.slice(0, 12)}`,
      approvalToken: `${stamp}.${digest}`,
    };
    if (approved) {
      if (approved[2] !== digest) {
        throw new HandoffError("The repository or plan changed since the preview. Run the preview again and approve its new token.", "scope_changed");
      }
    } else if (!(await confirm(preview))) {
      return { preview, result: null };
    }
    const result = await execute(preview, input, deps, scratch);
    return { preview, result };
  });
}

async function execute(preview: HandoffPreview, input: HandoffInput, deps: HandoffDeps, scratch: string): Promise<HandoffResult> {
  const { gateway } = deps;
  const { repo, snapshot, uploadId } = preview;
  const requestId = (suffix: string) => `req_${uploadId.replace(/-/g, "_")}_${suffix}`;
  let repoPath: string | null = null;
  let uploadedFull = false;

  const upload = async (full: boolean): Promise<HandoffBundle | null> => {
    const dir = join(scratch, full ? "full" : "thin");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const bundle = await createHandoffBundle({ repo, snapshot, uploadId, outputDir: dir, thin: !full });
    if (!bundle) return null;
    if (bundle.bytes > MAX_BUNDLE_BYTES) {
      throw new HandoffError("This repository is too large to hand off as a bundle. Push the branch to GitHub and retry.", "bundle_too_large");
    }
    const parts = await splitIntoParts(bundle.path, bundle.bytes, dir);
    for (const [index, part] of parts.entries()) {
      deps.log(`Uploading ${full ? "repository" : "changes"} (${index + 1}/${parts.length})…`);
      await gateway.uploadFile(part, `${HANDOFF_STAGE_DIR}/${uploadId}/bundle.part-${String(index).padStart(4, "0")}`);
    }
    uploadedFull = full;
    return bundle;
  };

  try {
    let project: MatrixProject;
    let bundle: HandoffBundle | null;
    if (preview.project.action === "reuse") {
      project = preview.project.project;
      bundle = await upload(false);
    } else {
      let created: MatrixProject | null = null;
      if (preview.project.action === "create_github") {
        deps.log(`Cloning ${preview.project.url} into a new Matrix project…`);
        try {
          created = await gateway.createProject({
            mode: "github",
            url: preview.project.url,
            slug: preview.project.slug,
            name: repo.github?.repo ?? repo.name,
            clientRequestId: requestId("project"),
          });
        } catch (error: unknown) {
          if (!(error instanceof HandoffApiError)) throw error;
          if (error.code === "slug_conflict") {
            created = await gateway.createProject({
              mode: "github",
              url: preview.project.url,
              slug: fallbackProjectSlug(repo.name, repo.rootCommit),
              name: repo.github?.repo ?? repo.name,
              clientRequestId: requestId("project_alt"),
            });
          } else if (error.code === "github_auth_required" || error.code === "clone_failed") {
            // GitHub is not connected on Matrix or cannot reach this repository:
            // seed the project from a full bundle instead.
            deps.log("Matrix cannot clone this repository from GitHub; uploading it instead.");
          } else {
            throw error;
          }
        }
      }
      if (created) {
        project = created;
        bundle = await upload(false);
      } else {
        const slug = fallbackProjectSlug(repo.name, repo.rootCommit);
        bundle = await upload(true);
        const seeded = await runScript(gateway, seedProjectCommand({
          uploadId,
          bundleSha256: bundle!.sha256,
          slug,
          branch: preview.branch,
          head: repo.head,
          originUrl: repo.github ? githubHttpsUrl(repo.github) : repo.originUrl,
        }), "create the project folder");
        if (seeded.result !== "ok" && seeded.result !== "destination_exists") {
          throw new HandoffError("Matrix could not create the project folder.", "seed_failed");
        }
        project = await gateway.createProject({
          mode: "folder",
          name: repo.name,
          slug,
          path: `projects/${slug}`,
          clientRequestId: requestId("folder"),
        });
      }
    }
    repoPath = project.localPath;

    deps.log(`Updating ${project.slug} on Matrix…`);
    const integrateWith = (current: HandoffBundle | null) => runScript(gateway, integrateCommand({
      uploadId,
      bundleSha256: current?.sha256 ?? null,
      repoPath: project.localPath,
      slug: project.slug,
      branch: preview.branch,
      sideBranch: preview.sideBranch,
      head: repo.head,
      snapshot: snapshot.commit,
    }), "bring your commits into the project");
    let integrated = await integrateWith(bundle);
    if (integrated.result === "needs_full_bundle" && !uploadedFull) {
      deps.log("Matrix is missing the base commits; uploading the full history…");
      await runScript(gateway, cleanupCommand({ uploadId, repoPath: null }), "reset the upload");
      bundle = await upload(true);
      integrated = await integrateWith(bundle);
    }
    if (integrated.result !== "ok" || !integrated.branch) {
      throw new HandoffError(`Matrix could not prepare the branch (${integrated.result}).`, integrated.result ?? "integrate_failed");
    }
    const branch = integrated.branch;

    let checkoutPath: string;
    let executionRoot: HandoffResult["executionRoot"];
    if (integrated.checkout && integrated.checkout === project.localPath) {
      checkoutPath = project.localPath;
      executionRoot = { kind: "project", projectId: project.id };
    } else {
      const worktree = await gateway.createWorktree(project.slug, branch);
      checkoutPath = worktree.path;
      executionRoot = { kind: "worktree", projectId: project.id, worktreeId: worktree.id };
    }

    const applied = await runScript(gateway, applySnapshotCommand({
      uploadId,
      repoPath: project.localPath,
      checkoutPath,
      head: repo.head,
      snapshot: snapshot.commit,
    }), "apply your uncommitted changes");
    if (applied.result !== "ok") {
      throw new HandoffError(`Matrix could not apply your uncommitted changes (${applied.result}).`, applied.result ?? "apply_failed");
    }
    await runScript(gateway, cleanupCommand({ uploadId, repoPath: project.localPath }), "clean up the upload");
    repoPath = null;

    let transcriptChat: { chatId: string } | null = null;
    if (preview.transcript) {
      deps.log("Importing the local transcript as a private Chat…");
      transcriptChat = await deps.importTranscript(preview.transcript, `${preview.title} (local history)`);
    }

    const message = buildMessage({
      brief: input.brief,
      repo,
      branch,
      requestedBranch: preview.branch,
      snapshot,
      unpushedCommits: preview.unpushedCommits,
      transcript: transcriptChat,
    });
    deps.log("Starting the Matrix Chat…");
    const chat = await gateway.createChat({
      clientRequestId: requestId("chat"),
      title: preview.title,
      projectId: project.id,
      currentSelection: preview.selection,
    });
    await gateway.startTurn(chat.id, {
      clientRequestId: requestId("turn"),
      baseRevision: chat.revision,
      parts: [{ type: "text", text: message }],
      selection: preview.selection,
      interactionMode: preview.interactionMode,
      permissionMode: preview.permissionMode,
      executionRoot,
    });
    // Keep a /vm/<handle> base path so the link opens the same computer.
    const url = new URL(input.gatewayUrl);
    url.pathname = url.pathname.replace(/\/*$/, "/");
    url.search = "";
    url.hash = "";
    url.searchParams.set("launch", "__chat__");
    url.searchParams.set("chat", chat.id);
    return {
      projectSlug: project.slug,
      branch,
      usedSideBranch: branch !== preview.branch,
      executionRoot,
      checkoutPath,
      chatId: chat.id,
      transcriptChatId: transcriptChat?.chatId ?? null,
      url: url.toString(),
    };
  } catch (error: unknown) {
    try {
      await gateway.run(cleanupCommand({ uploadId, repoPath }));
    } catch (cleanupError: unknown) {
      deps.log(`Cleanup of the Matrix upload failed (${cleanupError instanceof Error ? cleanupError.name : "UnknownError"}); it is safe to retry the handoff.`);
    }
    throw error;
  }
}
