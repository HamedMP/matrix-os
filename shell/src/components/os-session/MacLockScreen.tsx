"use client";

import { useState } from "react";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { StartMenuUser } from "../taskbar/taskbar-shared";
import { useOsSessionStore } from "./os-session-store";

/**
 * macOS lock screen (simulation): frosted/blurred wallpaper backdrop (the
 * wallpaper lives on <body>, so a translucent backdrop-filter layer reproduces
 * the lock-screen frost), centered avatar + user name, and a password-style
 * input that unlocks on Enter — any password works, this never signs out.
 */
export function MacLockScreen() {
  const close = useOsSessionStore((s) => s.close);
  const [password, setPassword] = useState("");

  return (
    // react-doctor-disable-next-line react-doctor/prefer-html-dialog -- full-screen OS lock surface, not a modal: frosted-wallpaper layout with autofocus password field; native <dialog> focus trapping/UA styling conflicts with the macOS lock-screen look
    <div
      role="dialog"
      aria-modal="true"
      aria-label="macOS lock screen"
      className="os-mac-lock"
      style={{ zIndex: SHELL_Z_INDEX.lockScreen }}
    >
      <StartMenuUser avatarSize={72} className="os-mac-lock-user" />
      <form
        className="os-mac-lock-form"
        onSubmit={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus, react-doctor/no-autofocus -- mirrors the real macOS lock screen: the password field is focused immediately so typing unlocks without a click
          autoFocus
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              close();
            }
          }}
          placeholder="Enter Password"
          aria-label="Password"
          className="os-mac-lock-input"
        />
      </form>
      <p className="os-mac-lock-hint">Press Return to log in</p>
    </div>
  );
}
