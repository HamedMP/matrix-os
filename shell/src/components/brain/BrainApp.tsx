"use client";

import {
  BrainApp as SharedBrainApp, createBrainShellApi, listBrainProjects, type BrainAppProps,
} from "@matrix-os/ui";
import { shellApi } from "@/api/http";

/** The shared Company Brain view bound to the Web gateway client (same-origin session). */
const shellBrainApi = createBrainShellApi(shellApi);
const loadShellProjects = () => listBrainProjects(shellApi);

export type ShellBrainAppProps = Omit<BrainAppProps, "api" | "loadProjects">;

/** Web Desktop, Web Canvas and Web Mobile render this; the windowed surfaces pass `showHeading={false}`. */
export function BrainApp(props: ShellBrainAppProps) {
  return <SharedBrainApp api={shellBrainApi} loadProjects={loadShellProjects} {...props} />;
}
