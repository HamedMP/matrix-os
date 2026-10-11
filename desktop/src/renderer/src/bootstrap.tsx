import React from "react";
import type { Root } from "react-dom/client";
import { INVOKE_CHANNELS } from "../../shared/ipc-contract";
import { AuthDiagnostic } from "./AuthDiagnostic";
import { invoke } from "./lib/operator";

export async function mountDesktopRenderer(root: Root): Promise<void> {
  try {
    const { mode } = INVOKE_CHANNELS["app:get-startup-mode"].response.parse(
      await invoke("app:get-startup-mode", {}),
    );
    if (mode === "auth-diagnostic") {
      const [auth, version] = await Promise.allSettled([
        invoke("auth:status", {}).then(value => INVOKE_CHANNELS["auth:status"].response.parse(value)),
        invoke("app:get-version", {}).then(value => INVOKE_CHANNELS["app:get-version"].response.parse(value)),
      ]);
      root.render(<AuthDiagnostic auth={auth.status === "fulfilled" ? auth.value : null}
        version={version.status === "fulfilled" ? version.value : null} />);
      return;
    }
    const { NormalDesktop } = await import("./normal-desktop");
    root.render(<React.StrictMode><NormalDesktop /></React.StrictMode>);
  } catch (error: unknown) {
    console.warn("[desktop] startup verification failed", error instanceof Error ? error.name : "unknown error");
    root.render(<p role="alert">Desktop startup could not be verified.</p>);
  }
}
