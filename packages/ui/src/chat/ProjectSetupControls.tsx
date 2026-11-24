import { useLayoutEffect, useRef, useState } from "react";
import type { CanonicalChatModelSelection, ProjectSetupDraft } from "@matrix-os/contracts";
import { useProjectSetupMcpConnection } from "./project-setup-presentation.js";
import { Button } from "../Button.js";
import {
  ImportSkillForm,
  InstalledSkillForm,
  type ProjectSkillSourceActions,
} from "./ProjectSkillActions.js";
import { copyProjectSkill, importProjectSkill } from "./project-skill-file.js";
import type { ProjectSetupController, ProjectSetupTransport } from "./use-project-setup.js";

import { ProjectSetupActionButton as Action, borderStyle, mutedStyle } from "./ProjectSetupAction.js";
import { ProjectSetupMarkdown, type ProjectSetupMarkdownState } from "./ProjectSetupMarkdown.js";
import { ProjectSetupReviewSummary } from "./ProjectSetupReviewSummary.js";
import { ProjectSetupReplyContext, projectSetupReplyContent, isCompactSetupAnswer, disclosureStyle } from "./ProjectSetupProgress.js";
export { ProjectSetupEntry, ProjectSetupIntroduction } from "./ProjectSetupEntry.js";

interface Props extends ProjectSkillSourceActions {
  setup: ProjectSetupController;
  transport: ProjectSetupTransport | null;
  selection?: CanonicalChatModelSelection | null;
  onOpenMcpSettings?: () => void;
  replyText?: string;
  mcpSettingsOpen?: boolean;
  markdownEdits?: {
    files: Readonly<Record<string, ProjectSetupMarkdownState>>;
    onChange: (path: string, state: ProjectSetupMarkdownState) => void;
  };
  onOpenFile?: (path: string) => void | Promise<boolean>;
}

const isPreservedMarkdown = (file: ProjectSetupDraft["proposals"][number]) =>
  file.status === "saved" || file.status === "already_present";

function guidanceLimit(file: ProjectSetupDraft["proposals"][number]): number | undefined {
  return !file.path.endsWith("/SKILL.md") && !isPreservedMarkdown(file) ? 8192 : undefined;
}

/** Actions follow the canonical assistant message; the transcript stays in Chat. */
export function ProjectSetupControls(props: Props) {
  const draft = props.setup.draft;
  if (!draft) return null;
  return (
    <ProjectSetupControlsScoped key={`${draft.chatId}:${props.setup.identity}`} {...props} draft={draft} />
  );
}

function ProjectSetupControlsScoped({
  setup,
  draft,
  transport,
  selection,
  onOpenMcpSettings,
  replyText,
  mcpSettingsOpen = false,
  markdownEdits,
  onOpenFile,
  loadInstalledSkills,
  readInstalledSkill,
}: Props & { draft: ProjectSetupDraft }) {
  const [source, setSource] = useState<"import" | "installed" | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const interview = draft.interview;
  const recommendedService = interview ? interview.recommendedService : "Linear";
  const awaitingReply = draft.generation?.status === "pending" || draft.generation?.status === "running";
  const replyFailed = draft.generation?.status === "failed" || draft.generation?.status === "unavailable";
  const offerSkill = interview ? interview.focus === "skill" && draft.step !== "saved" : draft.step === "skill";
  const pendingService = draft.mcp.state === "pending" ? draft.mcp.service : undefined;
  const showConnectionCard = pendingService && setup.mcpHandoff;
  const offerConnection = interview
    ? draft.step !== "saved" && (!pendingService || pendingService !== recommendedService)
      && (interview.focus === "mcp" || (interview.focus === "review" && Boolean(recommendedService)))
    : draft.step === "mcp";
  const showReview = draft.step === "review" && !showConnectionCard;
  const unavailableDestination = draft.proposals.some(file => file.status === "destination_unavailable");
  const reviewableFiles = draft.proposals.filter(file => !["symlink_skipped", "destination_unavailable"].includes(file.status));
  const [dirtyFiles, setDirtyFiles] = useState<string[]>(() =>
    Object.entries(markdownEdits?.files ?? {})
      .filter(([path, edit]) => edit.value !== edit.baseline &&
        draft.proposals.some(file => file.path === path && file.content !== edit.value))
      .map(([path]) => path),
  );
  const sourceRequest = useRef<AbortController | null>(null);
  const [revisionField, setRevisionField] = useState<"purpose" | "guidance" | "skillInstructions" | null>(
    null,
  );
  const [revisionText, setRevisionText] = useState("");
  useLayoutEffect(() => () => sourceRequest.current?.abort(), []);
  const { connected, checkConnection } = useProjectSetupMcpConnection(
    transport, showConnectionCard || showReview ? pendingService : undefined, mcpSettingsOpen,
  );
  const busy = setup.pending || reading;
  const reviewing = draft.step === "review";
  const reply = interview && replyText ? projectSetupReplyContent(replyText, reviewing) : null;
  const replyPrompt = reply?.prompt ? <p className="leading-relaxed">{reply.prompt}</p> : null;
  const replyContext = reply?.detail && (reviewing || !reply.prompt)
    ? <ProjectSetupReplyContext detail={reply.detail} review={reviewing} />
    : null;
  const suggestions = interview && draft.step !== "saved" && !showConnectionCard ? interview.suggestions : [];
  const connectLabel = recommendedService ? `Connect ${recommendedService}` : "Open MCP Settings";
  const longConnection = Boolean(interview && !isCompactSetupAnswer(connectLabel));
  const reservedActions = Number(offerSkill) + (longConnection ? 1 : 2) * Number(offerConnection) + Number(showReview);
  const shortAnswers = suggestions.filter(isCompactSetupAnswer)
    .slice(0, Math.max(0, 3 - reservedActions));
  const answerChoices = shortAnswers.length ? (
    <div className="flex flex-wrap gap-2" aria-label="Suggested answers" role="group">
      {shortAnswers.map((text) => (
        <Action key={text} disabled={busy} onClick={() => { void setup.answer(text); }}>
          <span className="min-w-0 whitespace-normal break-words">{text}</span>
        </Action>
      ))}
    </div>
  ) : null;
  const needsSkillDraft = Boolean(draft.answers.skillInstructions && !draft.skill);
  const revisionFields: Array<"purpose" | "guidance" | "skillInstructions"> = draft.answers.skillInstructions
    ? ["purpose", "guidance", "skillInstructions"]
    : ["purpose", "guidance"];
  const dispatch = (action: Parameters<ProjectSetupController["dispatch"]>[0]) => {
    void setup.dispatch(action);
  };

  const connect = recommendedService ? (
    <Action disabled={busy || !onOpenMcpSettings} onClick={() => dispatch({ type: "choose_mcp", choice: "connect", service: recommendedService })}>
      <span className="min-w-0 whitespace-normal break-words">{connectLabel}</span>
    </Action>
  ) : onOpenMcpSettings ? (
    <Action disabled={busy || mcpSettingsOpen} onClick={onOpenMcpSettings}>{connectLabel}</Action>
  ) : null;

  const stage = async (prepare: (signal: AbortSignal) => ReturnType<typeof importProjectSkill>) => {
    if (busy || sourceRequest.current) return;
    const controller = new AbortController();
    sourceRequest.current = controller;
    setReading(true);
    setSourceError(null);
    try {
      const selected = await prepare(controller.signal);
      if (controller.signal.aborted) return;
      if ("error" in selected) {
        setSourceError(selected.error);
        return;
      }
      if (await setup.dispatch({ type: "stage_skill", content: selected.content })) setSource(null);
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        console.warn(
          "[project-setup] Skill unavailable",
          error instanceof Error ? error.name : "UnknownError",
        );
        setSourceError("The skill could not be read. Your answers are kept.");
      }
    } finally {
      if (sourceRequest.current === controller) {
        sourceRequest.current = null;
        if (!controller.signal.aborted) setReading(false);
      }
    }
  };

  const openSavedFile = async (path: string) => {
    setSourceError(null);
    try {
      if ((await onOpenFile?.(path)) === false) setSourceError("The file could not be opened. Try again.");
    } catch (error: unknown) {
      console.warn(
        "[project-setup] File could not be opened",
        error instanceof Error ? error.name : "UnknownError",
      );
      setSourceError("The file could not be opened. Try again.");
    }
  };
  if (interview && draft.step !== "saved" && (awaitingReply || replyFailed)) {
    return (
      <div className="space-y-2 text-sm" data-slot="project-setup-controls">
        {replyPrompt}{replyContext}
        {awaitingReply ? (
          <>
            <p role="status" style={mutedStyle}>Preparing the next reply…</p>
            {setup.error ? <p role="alert" className="text-xs">{setup.error}</p> : null}
            {setup.error || setup.replyPollingExhausted ? (
              <Action disabled={busy} onClick={() => dispatch({ type: "sync_generation" })}>Check reply status</Action>
            ) : null}
          </>
        ) : (
          <>
            <p role="alert" className="text-xs">
              The Agent couldn’t continue. Your answers are kept. Send a revised answer or retry with the selected model.
            </p>
            <div className="flex flex-wrap gap-2">
              <Action disabled={busy || !selection} onClick={() => { void setup.retryInterview(); }}>
                Retry with selected model
              </Action>
            </div>
            {setup.error ? <p role="alert" className="text-xs">{setup.error}</p> : null}
          </>
        )}
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-3 text-sm" data-slot="project-setup-controls" aria-busy={busy}>
      {replyPrompt}
      {replyContext}
      {answerChoices}
      {!interview && draft.step !== "saved" ? (
        <Action variant="ghost" disabled={busy || awaitingReply} onClick={() => { void setup.start(); }}>
          Continue with Agent
        </Action>
      ) : null}
      {!interview && draft.step === "guidance" ? (
        <>
          <div className="flex flex-wrap gap-2">
            {([
              ["Keep changes small", "Keep changes small, run checks, and ask before publishing."],
              ["Suggest a starting point", "Explain the plan before making changes."],
            ] as const).map(([label, text]) => (
              <Action
                key={label}
                disabled={busy}
                onClick={() => {
                  void setup.answer(text);
                }}
              >
                {label}
              </Action>
            ))}
          </div>
          <p className="text-xs" style={mutedStyle}>Or write your own guidance below.</p>
        </>
      ) : null}
      {offerSkill ? (
        <>
          <div className="flex flex-wrap gap-2">
            {!interview ? <Action disabled={busy} onClick={() => dispatch({ type: "choose_skill", choice: "create" })}>
              Create a skill
            </Action> : null}
            {!interview ? <SkillSourceButtons {...{ busy, setSource, loadInstalledSkills, readInstalledSkill }} /> : null}
            <Action disabled={busy} variant={interview ? "ghost" : undefined} onClick={() => dispatch({ type: "choose_skill", choice: "skip" })}>
              {interview ? "Skip skill" : "Skip for now"}
            </Action>
          </div>
          {interview ? <details key={`skill:${draft.currentQuestionMessageId}`}>
            <summary className={disclosureStyle}>Use an existing skill</summary>
            <div className="mt-2 flex flex-wrap gap-2">
              <SkillSourceButtons {...{ busy, setSource, loadInstalledSkills, readInstalledSkill }} />
            </div>
          </details> : null}
          {source === "import" ? (
            <ImportSkillForm
              busy={busy}
              onSubmit={(file) => {
                void stage(() => importProjectSkill(file));
              }}
            >
              <Action disabled={busy} onClick={() => setSource(null)}>
                Cancel
              </Action>
            </ImportSkillForm>
          ) : null}
          {source === "installed" && loadInstalledSkills && readInstalledSkill ? (
            <InstalledSkillForm
              busy={busy}
              load={loadInstalledSkills}
              onSubmit={(skill) => {
                void stage(async (signal) =>
                  copyProjectSkill(await readInstalledSkill(skill.file, signal), skill.name),
                );
              }}
            >
              <Action disabled={busy} onClick={() => setSource(null)}>
                Cancel
              </Action>
            </InstalledSkillForm>
          ) : null}
        </>
      ) : null}
      {!interview && draft.step === "skill_instructions" ? (
        <div className="flex flex-wrap gap-2">
          <Action
            disabled={busy}
            onClick={() => {
              void setup.answer(
                "Before each release, run the relevant tests, review the diff, and summarize the changes. Name this skill release-check.",
              );
            }}
          >
            Use a release checklist
          </Action>
          <Action disabled={busy} onClick={() => dispatch({ type: "choose_skill", choice: "skip" })}>
            Continue without a skill
          </Action>
        </div>
      ) : null}
      {offerConnection && !showConnectionCard ? (
        <>
          <div className="flex flex-wrap gap-2">
            {!longConnection ? connect : null}
            <Action disabled={busy} onClick={() => dispatch({ type: "choose_mcp", choice: "skip" })}>
              Skip for now
            </Action>
          </div>
          {interview ? <details>
            <summary className={disclosureStyle}>{longConnection ? "Review connection" : "Connection details"}</summary>
            {longConnection && connect ? <div className="mt-2">{connect}</div> : null}
            <p className="mt-1 text-xs" style={mutedStyle}>Connections are managed for this computer. Tool approvals still apply.</p>
          </details> : <p className="text-xs" style={mutedStyle}>Connections are managed for this computer. Tool approvals still apply.</p>}
        </>
      ) : null}
      {showConnectionCard ? (
        <section aria-label={`Connect ${pendingService}`} className="space-y-2 rounded-xl border px-4 py-3" style={borderStyle}>
          <h3 className="font-semibold">{pendingService}</h3>
          <p className="text-xs" role="status" style={mutedStyle}>
            {connected
              ? `${pendingService} is connected on this computer.`
              : "Awaiting MCP authorization"}
          </p>
          {!interview && !connected ? <p className="text-xs">
            Find {pendingService} under Add services in MCP Settings. Approve access there, then return here.
          </p> : null}
          <div className="flex flex-wrap gap-2">
            {onOpenMcpSettings && !connected ? <Action variant="primary" disabled={busy || mcpSettingsOpen} onClick={onOpenMcpSettings}>Open MCP Settings</Action> : null}
            {!interview ? <Action disabled={busy || mcpSettingsOpen} onClick={() => { void checkConnection(); }}>Check connection</Action> : null}
            <Action variant={connected ? "primary" : "ghost"} disabled={busy} onClick={() => {
              if (interview) void setup.answer("Continue setup with the MCP connection I selected.");
              else void setup.continueToReview();
            }}>{interview ? "Continue setup" : "Continue to review"}</Action>
            {!connected ? <Action variant="ghost" disabled={busy} onClick={() => dispatch({ type: "choose_mcp", choice: "skip" })}>
              Continue without connecting
            </Action> : null}
          </div>
          {interview ? <details>
            <summary className={disclosureStyle}>Connection details</summary>
            {!connected ? <p className="my-2 text-xs">Find {pendingService} under Add services in MCP Settings. Approve access there, then return here.</p> : null}
            <Action disabled={busy || mcpSettingsOpen} onClick={() => { void checkConnection(); }}>Check connection</Action>
          </details> : null}
        </section>
      ) : null}
      {showReview ? (
        <>
          {!interview ? <ProjectSetupReviewSummary draft={draft} connected={connected} /> : null}
          {interview && pendingService ? (
            <p className="text-xs" role="status" style={mutedStyle}>
              {connected ? `${pendingService} is connected on this computer.` : `${pendingService} authorization is pending.`}
            </p>
          ) : null}
          {!interview ? draft.generation?.status === "running" ? (
            <>
              <p role="status">Drafting your project files…</p>
              <Action disabled={busy} onClick={() => dispatch({ type: "sync_generation" })}>
                Check draft status
              </Action>
            </>
          ) : (
            <Action
              disabled={busy || !selection}
              onClick={() => selection && dispatch({ type: "generate", selection })}
            >
              {draft.generation?.runId ? "Regenerate drafts" : "Draft project files"}
            </Action>
          ) : null}
          {!interview && replyFailed ? (
            <div className="space-y-2">
              <p role="alert" className="text-xs">
                Drafting is unavailable with this model right now. Your answers are kept. Choose a supported
                model and try again.
              </p>
              {draft.answers.skillInstructions && !draft.skill ? (
                <Action disabled={busy} onClick={() => dispatch({ type: "choose_skill", choice: "skip" })}>
                  Continue without a skill
                </Action>
              ) : null}
            </div>
          ) : null}
          {reviewableFiles.length ? (
            <div
              className="divide-y divide-[var(--border-subtle,var(--border))] overflow-hidden rounded-lg border"
              style={borderStyle}
            >
              {reviewableFiles.map((file) => (
                <ProjectSetupMarkdown
                  key={`${draft.chatId}:${file.path}:${isPreservedMarkdown(file)}`}
                  path={file.path}
                  content={file.content}
                  maximumCharacters={guidanceLimit(file)}
                  initialState={isPreservedMarkdown(file) ? undefined : markdownEdits?.files[file.path]}
                  onStateChange={markdownEdits && !isPreservedMarkdown(file) ? (state) => markdownEdits.onChange(file.path, state) : undefined}
                  editable={file.path !== "CLAUDE.md" && !file.expectedHash && !isPreservedMarkdown(file)}
                  busy={busy}
                  onDirtyChange={dirty => setDirtyFiles(current => {
                    if (current.includes(file.path) === dirty) return current;
                    return dirty ? [...current, file.path] : current.filter(path => path !== file.path);
                  })}
                  onApply={(content) => setup.dispatch({ type: "review_file", path: file.path, content })}
                />
              ))}
            </div>
          ) : null}
          {interview || draft.proposals.length ? (
            <Button
              size="sm"
              className="min-h-8 max-w-full"
              disabled={
                busy || (!interview && needsSkillDraft)
                || reviewableFiles.some(file => !isPreservedMarkdown(file) && (dirtyFiles.includes(file.path) || file.content.length > (guidanceLimit(file) ?? Infinity)))
                || draft.generation?.status === "running"
              }
              onClick={() => dispatch({ type: "save" })}
            >
              {!draft.proposals.length ? "Finish setup" : unavailableDestination ? "Save available files" : "Save project setup"}
            </Button>
          ) : null}
          {!interview && needsSkillDraft ? (
            <p role="status" className="text-xs" style={mutedStyle}>
              Draft the skill with a supported model or continue without a skill before saving.
            </p>
          ) : null}
          {!interview ? <div className="flex flex-wrap gap-2">
            {revisionFields.map((field) => (
              <Action
                key={field}
                disabled={busy}
                onClick={() => {
                  setRevisionField(field);
                  setRevisionText(draft.answers[field] ?? "");
                }}
              >
                Revise {field === "skillInstructions" ? "skill" : field}
              </Action>
            ))}
          </div> : null}
        </>
      ) : null}
      {!interview && revisionField ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void setup.dispatch({ type: "revise", field: revisionField, text: revisionText }).then((ok) => {
              if (ok) setRevisionField(null);
            });
          }}
        >
          <textarea
            aria-label="Revised answer"
            value={revisionText}
            maxLength={4096}
            onChange={(event) => setRevisionText(event.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={busy || !revisionText.trim()}>
              Update answer
            </Button>
            <Action disabled={busy} onClick={() => setRevisionField(null)}>
              Cancel
            </Action>
          </div>
        </form>
      ) : null}
      {draft.proposals.some((file) => file.status !== "pending") ? (
        <ul className="space-y-2 text-xs">
          {draft.proposals.map((file) => (
            <li key={file.path} className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-all">
                {file.path} · {file.status === "symlink_skipped" ? "Symbolic link preserved" : file.status === "destination_unavailable"
                  ? "Destination unavailable" : file.status.replaceAll("_", " ")}
              </span>
              {onOpenFile && ["saved", "already_present", "conflict"].includes(file.status) ? (
                <Action
                  onClick={() => { void openSavedFile(file.path); }}
                >
                  Open file
                </Action>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {sourceError || setup.error ? (
        <div className="space-y-2">
          <p role="alert" className="text-xs">
            {sourceError ?? setup.error}
          </p>
          {setup.error ? <Action disabled={busy} onClick={() => { void setup.reload(); }}>Reload setup</Action> : null}
        </div>
      ) : null}
    </div>
  );
}

function SkillSourceButtons({ busy, setSource, loadInstalledSkills, readInstalledSkill }: ProjectSkillSourceActions & {
  busy: boolean;
  setSource: (source: "import" | "installed") => void;
}) {
  return (
    <>
      <Action disabled={busy} onClick={() => setSource("import")}>Import SKILL.md</Action>
      {loadInstalledSkills && readInstalledSkill ? (
        <Action disabled={busy} onClick={() => setSource("installed")}>Choose installed skill</Action>
      ) : null}
    </>
  );
}
