"use client";

import { ChevronLeft, Folder } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  BRAIN_CLONE_WAIT_MS, BRAIN_CLONE_WAIT_TRIES, brainAddErrorText, brainAddRequestId, brainCloneMayContinue,
  brainFolderName, brainProjectExists, brainProjectSlug, brainRepositoryLink, brainRepositoryName,
  type BrainProjectAdder,
} from "./brain-add-project.js";
import { brainShellError } from "./brain-client.js";
import { BrainButton, BrainChip, BrainInput } from "./brain-controls.js";
import { brainErrorText, brainSyncText } from "./brain-format.js";
import { BRAIN_TONE, BRAIN_TYPE } from "./brain-tone.js";
import type { BrainProjectOption, BrainShellClient } from "./brain-types.js";
import { BrainAlertText, BrainLoading, BrainView } from "./brain-ui.js";
import { brainStartOrRun } from "./use-brain-job.js";
import { useBrainLoad } from "./use-brain-load.js";

type Mode = "link" | "folder";
type Step = "cloning" | "waiting" | "adding" | "checking" | "connecting" | "syncing";

const STEP_TEXT: Readonly<Record<Step, string>> = {
  cloning: "Cloning the repository...",
  waiting: "Still cloning. A big repository can take a few minutes...",
  adding: "Adding the folder...",
  checking: "Checking the folder is a git repository...",
  connecting: "Connecting the repository to the brain...",
  syncing: "Starting the first sync...",
};

export interface BrainAddProjectProps {
  readonly api: BrainShellClient;
  readonly adder: BrainProjectAdder;
  readonly loadProjects: () => Promise<readonly BrainProjectOption[]>;
  /** The project to select, and a line to show about it ("" when there is nothing to add). */
  readonly onAdded: (project: BrainProjectOption, note: string) => void;
}

const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Add a project to the Company Brain: paste a GitHub link (cloned as a project) or pick a folder on this computer.
 * Either way the brain connects its repository and starts the first sync, then the app selects it. A project of that
 * name that is already there is just selected.
 */
export function BrainAddProject({ api, adder, loadProjects, onAdded }: BrainAddProjectProps) {
  const [mode, setMode] = useState<Mode>("link");
  const [link, setLink] = useState("");
  const [folder, setFolder] = useState("");
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const linkId = useId();
  const errorId = useId();

  /** The listed project of that slug, read fresh; null when there is none. */
  const listed = async (slug: string) => (await loadProjects()).find((project) => project.slug === slug) ?? null;

  /**
   * Connect the repository and start the first sync; a failure still selects the project, with the reason. The app
   * selects the project even when this panel was closed meanwhile.
   */
  const connect = async (project: BrainProjectOption) => {
    try {
      setStep("connecting");
      await api.registerGitSource(project.id, {});
      setStep("syncing");
      const outcome = await brainStartOrRun(api, project.id, { kind: "sync" },
        async () => brainSyncText(await api.syncGit(project.id)));
      onAdded(project, outcome.started ? `Added ${project.name}. The first sync is running.` : `Added ${project.name}. ${outcome.text}`);
    } catch (failure: unknown) {
      onAdded(project, `Added ${project.name}, but ${brainErrorText(brainShellError(failure))} Try again here in Sources.`);
    }
  };

  const addLink = async (url: string) => {
    const slug = brainProjectSlug(brainRepositoryName(url));
    setStep("cloning");
    let project: BrainProjectOption | null = null;
    try {
      project = await adder.clone(url, brainAddRequestId());
    } catch (failure: unknown) {
      if (brainProjectExists(failure)) {
        // Already there: select it as it is.
        const existing = await listed(slug);
        if (existing === null) throw failure;
        onAdded(existing, `${existing.name} is already a project. It is selected now.`);
        return;
      }
      if (!brainCloneMayContinue(failure)) throw failure;
      // The request was cut short, but the clone may still finish: watch the project list for it.
      setStep("waiting");
      for (let tries = 0; project === null && tries < BRAIN_CLONE_WAIT_TRIES && alive.current; tries += 1) {
        await wait(BRAIN_CLONE_WAIT_MS);
        project = await listed(slug).catch((error: unknown) => {
          console.warn("[brain] project list failed while a clone runs", error instanceof Error ? error.name : typeof error);
          return null;
        });
      }
      if (!alive.current) return;
      if (project === null) throw new Error("clone_wait");
    }
    await connect(project);
  };

  const addFolder = async (path: string) => {
    setStep("adding");
    let project: BrainProjectOption;
    try {
      project = await adder.addFolder(path, brainFolderName(path), brainAddRequestId());
    } catch (failure: unknown) {
      const existing = brainProjectExists(failure) ? await listed(brainProjectSlug(brainFolderName(path))) : null;
      if (existing === null) throw failure;
      onAdded(existing, `${existing.name} is already a project. It is selected now.`);
      return;
    }
    setStep("checking");
    if (!await adder.isGitRepository(project.slug)) {
      onAdded(project, `Added ${project.name}, but this folder is not a git repository, so the brain has nothing `
        + "to read. Run git init in it, or pick a folder that is a git repository.");
      return;
    }
    await connect(project);
  };

  const run = (work: () => Promise<void>) => {
    setError("");
    work().then(
      () => { if (alive.current) setStep(null); },
      (failure: unknown) => {
        if (!alive.current) return;
        setStep(null);
        setError(failure instanceof Error && failure.message === "clone_wait"
          ? "The clone is taking a long time. Look for the project in the Project menu later."
          : brainAddErrorText(failure));
      },
    );
  };

  const busy = step !== null;
  const onSubmitLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = brainRepositoryLink(link);
    if (url === null) { setError("Paste a GitHub link like https://github.com/owner/repo."); return; }
    run(() => addLink(url));
  };

  return (
    <div className="grid gap-3">
      <div role="group" aria-label="Add from" className="flex flex-wrap gap-2">
        <BrainChip selected={mode === "link"} disabled={busy} onClick={() => { setMode("link"); setError(""); }}>
          Repository link
        </BrainChip>
        <BrainChip selected={mode === "folder"} disabled={busy} onClick={() => { setMode("folder"); setError(""); }}>
          Folder on this computer
        </BrainChip>
      </div>
      {mode === "link" ? (
        <form className="grid gap-2" onSubmit={onSubmitLink}>
          <label htmlFor={linkId} className={`font-medium ${BRAIN_TYPE.label}`}>Repository link</label>
          <div className="flex flex-wrap gap-2">
            <BrainInput id={linkId} type="url" inputMode="url" autoComplete="off" spellCheck={false} maxLength={512}
              className="min-w-48 flex-1" placeholder="https://github.com/owner/repo" value={link} disabled={busy}
              aria-invalid={error !== "" || undefined} aria-describedby={error !== "" ? errorId : undefined}
              onChange={(event) => { setLink(event.target.value); setError(""); }} />
            <BrainButton type="submit" disabled={busy || link.trim() === ""}>Add project</BrainButton>
          </div>
          <p className={`${BRAIN_TYPE.caption} ${BRAIN_TONE.secondary}`}>
            It is cloned as a new project, connected to the brain and synced.
          </p>
        </form>
      ) : (
        <BrainFolderPicker adder={adder} path={folder} onPath={(path) => { setFolder(path); setError(""); }}
          busy={busy} onAdd={() => run(() => addFolder(folder))} />
      )}
      {step !== null && <BrainLoading label={STEP_TEXT[step]} />}
      {error !== "" && <BrainAlertText id={errorId} role="alert">{error}</BrainAlertText>}
    </div>
  );
}

/** Folders of the Matrix home, one level at a time: open one, go up, or add the one open now. */
function BrainFolderPicker({ adder, path, onPath, busy, onAdd }: {
  readonly adder: BrainProjectAdder; readonly path: string; readonly onPath: (path: string) => void;
  readonly busy: boolean; readonly onAdd: () => void;
}) {
  const list = useBrainLoad(() => adder.folders(path), `folders:${path}`);
  const up = path.split("/").slice(0, -1).join("/");
  return (
    <div className="grid gap-2">
      <p className={`font-medium ${BRAIN_TYPE.label}`}>Pick a folder</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <BrainButton size="sm" variant="outline" disabled={busy || path === ""} onClick={() => onPath(up)}>
          <ChevronLeft className="size-4" aria-hidden="true" />
          Up
        </BrainButton>
        <span className={`min-w-0 truncate ${BRAIN_TYPE.footnote} ${BRAIN_TYPE.machine} ${BRAIN_TONE.secondary}`}>
          {path === "" ? "Home" : `Home/${path}`}
        </span>
      </div>
      <BrainView state={list.state} label="Loading folders..." onRetry={list.reload}>
        {(names) => names.length === 0 ? (
          <p className={`${BRAIN_TYPE.caption} ${BRAIN_TONE.secondary}`}>No folders in here.</p>
        ) : (
          <ul aria-label="Folders" className={`grid max-h-56 gap-0.5 overflow-auto p-1 ${BRAIN_TONE.fill}`}>
            {names.map((name) => (
              <li key={name}>
                <BrainButton size="sm" variant="ghost" disabled={busy} className="w-full justify-start"
                  onClick={() => onPath(path === "" ? name : `${path}/${name}`)}>
                  <Folder className={`size-4 ${BRAIN_TONE.secondary}`} aria-hidden="true" />
                  <span className="min-w-0 truncate">{name}</span>
                </BrainButton>
              </li>
            ))}
          </ul>
        )}
      </BrainView>
      <div className="flex flex-wrap items-center gap-2">
        <BrainButton disabled={busy || path === ""} onClick={onAdd}>
          {path === "" ? "Open a folder to add it" : `Add ${brainFolderName(path)}`}
        </BrainButton>
      </div>
      <p className={`${BRAIN_TYPE.caption} ${BRAIN_TONE.secondary}`}>
        The folder stays where it is. It must be a git repository for the brain to read it.
      </p>
    </div>
  );
}
