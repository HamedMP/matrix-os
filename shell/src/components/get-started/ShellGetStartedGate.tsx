"use client";

import { GetStartedGate } from "@matrix-os/ui";
import { useState, type ReactNode } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { createShellGetStartedPort } from "./shell-get-started-port";
import { ShellGetStartedConnector } from "./ShellGetStartedConnector";

/** The web shell paints the wallpaper on `<body>` (useDesktopConfig). */
const bodyBackdrop = () => document.body;

/** Web Desktop and Web Canvas: the wizard runs first, then the onboarding widget it wraps. */
export function ShellGetStartedGate({ children }: { children: ReactNode }) {
  // Read once, like the onboarding widget: switching computers reloads the page.
  const [port] = useState(() => createShellGetStartedPort(getGatewayUrl()));
  return <GetStartedGate port={port} zIndex={SHELL_Z_INDEX.getStarted} connector={ShellGetStartedConnector} backdropSource={bodyBackdrop}>{children}</GetStartedGate>;
}
