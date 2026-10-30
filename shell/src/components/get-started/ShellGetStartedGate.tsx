"use client";

import { useUser } from "@clerk/nextjs";
import { GetStartedGate } from "@matrix-os/ui";
import { useState, type ReactNode } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { getShellFeatureFlagSource } from "@/lib/posthog-client";
import { isSelfHostedRuntime } from "@/lib/self-host-mode";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { createShellGetStartedGalleryPort, createShellGetStartedPort } from "./shell-get-started-port";
import { ShellGetStartedAgentLogin } from "./ShellGetStartedAgentLogin";
import { ShellGetStartedConnector } from "./ShellGetStartedConnector";

/** The web shell paints the wallpaper on `<body>` (useDesktopConfig). */
const bodyBackdrop = () => document.body;

/** Web Desktop and Web Canvas: the wizard runs first, then the onboarding widget it wraps. */
export function ShellGetStartedGate({ children }: { children: ReactNode }) {
  // Self-hosted documents render without ClerkProvider, so useUser must never run there.
  // react-doctor-disable-next-line react-doctor/no-hydration-branch-on-browser-global -- both sides read the same MATRIX_SELF_HOSTED flag: the server from its env, the client from the data-matrix-self-hosted attribute the root layout renders from that env
  if (isSelfHostedRuntime()) return <ShellGate suggestedName={null} rollout={false}>{children}</ShellGate>;
  return <ClerkShellGate>{children}</ClerkShellGate>;
}

/** The sign-in account's first name (from Google or GitHub) pre-fills the name step. */
function ClerkShellGate({ children }: { children: ReactNode }) {
  const { user } = useUser();
  return <ShellGate suggestedName={user?.firstName ?? null} rollout>{children}</ShellGate>;
}

/** `rollout`: read the PostHog flag. Self-hosted computers have no Matrix PostHog, so their gateway alone decides. */
function ShellGate({ suggestedName, rollout, children }: { suggestedName: string | null; rollout: boolean; children: ReactNode }) {
  // Read once, like the onboarding widget: switching computers reloads the page.
  const [port] = useState(() => createShellGetStartedPort(getGatewayUrl()));
  const [gallery] = useState(() => createShellGetStartedGalleryPort(getGatewayUrl()));
  const [featureFlags] = useState(() => (rollout ? getShellFeatureFlagSource() : undefined));
  return <GetStartedGate port={port} zIndex={SHELL_Z_INDEX.getStarted} connector={ShellGetStartedConnector} gallery={gallery} backdropSource={bodyBackdrop} suggestedName={suggestedName} agentLogin={ShellGetStartedAgentLogin} featureFlags={featureFlags}>{children}</GetStartedGate>;
}
