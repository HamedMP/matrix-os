import React from "react";
import { createRoot } from "react-dom/client";
import { desktopPalette, fonts } from "../../../packages/brand/src/tokens";
import { ShellAuthLayout } from "../../../shell/src/components/auth/ShellAuthLayout";
import "./auth-review.css";

// Visual review only: this fixture never collects credentials or performs authentication.
createRoot(document.getElementById("root")!).render(
  <ShellAuthLayout eyebrow="Matrix OS" title="Welcome back. Make it happen."
    body="Your apps, ideas, and conversations, together in your own computer. Sign in to pick up where you left off.">
    <div className="p-5" style={{ fontFamily: fonts.ui }}>
      <h2 className="text-2xl font-bold" style={{ fontFamily: fonts.heading }}>Sign in to Matrix OS</h2>
      <p className="mt-2 text-sm text-neutral-500">Welcome back! Please sign in to continue.</p>
      <button disabled className="mt-7 h-11 w-full rounded-xl border border-neutral-200 text-sm font-medium">Continue with Google</button>
      <div className="my-6 text-center text-xs text-neutral-400">or</div>
      <label className="text-sm font-medium" htmlFor="preview-email">Email address</label>
      <input disabled id="preview-email" className="mt-2 h-11 w-full rounded-xl border border-neutral-200 px-3" placeholder="you@example.com" />
      <button disabled className="mt-5 h-11 w-full rounded-xl text-sm font-medium text-white" style={{ backgroundColor: desktopPalette.forest }}>Continue</button>
      <p className="mt-6 text-center text-xs text-neutral-500">Design preview — sign-in is available in the hosted app.</p>
    </div>
  </ShellAuthLayout>,
);
