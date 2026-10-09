"use client";

import {
  BrainApp as SharedBrainApp, createBrainShellApi, listBrainProjects, type BrainAppProps,
} from "@matrix-os/ui";
import { shellApi } from "@/api/http";
import { useShellBrainChatHost } from "./BrainChatHost";

/** The shared Company Brain view bound to the Web gateway client (same-origin session). */
const shellBrainApi = createBrainShellApi(shellApi);
const loadShellProjects = () => listBrainProjects(shellApi);

export type ShellBrainAppProps = Omit<BrainAppProps, "api" | "loadProjects" | "chat"> & {
  /** Web Mobile: touch sizes in the chat, and Open in Chat switches to the Chat app. */
  readonly mobile?: boolean;
  /** The window is focused and shown: like the Chat window, the chat marks answers read only then. */
  readonly active?: boolean;
  /** The window is shown (not minimized or in the background): the chat's Bot panel runs only then. */
  readonly visible?: boolean;
};

/**
 * Web Desktop, Web Canvas and Web Mobile render this; the windowed surfaces pass `showHeading={false}`. The Chat tab
 * shows the shell's own Chat view for the project's brain chat.
 */
export function BrainApp({ mobile = false, active = true, visible = true, ...props }: ShellBrainAppProps) {
  const chat = useShellBrainChatHost(mobile, active, visible);
  return <SharedBrainApp api={shellBrainApi} loadProjects={loadShellProjects} chat={chat} {...props} />;
}
