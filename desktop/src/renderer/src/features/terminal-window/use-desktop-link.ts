// Which of the person's computers may use this device (spec 2716), as main
// reports it. The renderer never holds a key, bearer or link; it asks main to
// switch a computer on or off and shows what main says.
import { useCallback, useEffect, useState } from "react";
import { z } from "zod/v4";
import { DesktopLinkStatusSchema, type DesktopLinkStatusEntry } from "../../../../shared/desktop-link";
import { invoke, onEvent } from "../../lib/operator";

export type DesktopLinkEnableFailure = "signed_out" | "denied" | "too_many" | "unavailable";

export const DESKTOP_LINK_ENABLE_FAILURE: Record<DesktopLinkEnableFailure, string> = {
  signed_out: "Sign in to Matrix OS first.",
  denied: "That computer did not allow this device. Only its owner can link a desktop.",
  too_many: "That computer already has five desktops. Remove one there first.",
  unavailable: "Couldn't reach that computer. Try again.",
};

export function useDesktopLink() {
  const [computers, setComputers] = useState<readonly DesktopLinkStatusEntry[]>([]);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [failure, setFailure] = useState<DesktopLinkEnableFailure | null>(null);

  useEffect(() => {
    let live = true;
    invoke("desktop-link:status", {}).then(
      (status) => {
        // Main validates the answer; a reply of any other shape shows no computers.
        const parsed = z.strictObject({ computers: z.array(DesktopLinkStatusSchema).max(20) }).safeParse(status);
        if (live) setComputers(parsed.success ? parsed.data.computers : []);
      },
      (error: unknown) => { console.warn("[desktop-link] status failed", error instanceof Error ? error.name : "unknown_error"); },
    );
    const stop = onEvent("desktop-link:changed", (payload) => {
      const parsed = DesktopLinkStatusSchema.safeParse(payload);
      if (!parsed.success) return;
      const changed = parsed.data;
      setComputers((current) => {
        const others = current.filter((entry) => entry.slot !== changed.slot);
        return [...others, changed].sort((left, right) => left.computerName.localeCompare(right.computerName));
      });
    });
    return () => { live = false; stop(); };
  }, []);

  const enable = useCallback(async (slot: string, computerName: string): Promise<boolean> => {
    setBusySlot(slot);
    setFailure(null);
    try {
      const result = await invoke("desktop-link:enable", { slot, computerName });
      if (!result.ok) setFailure(result.reason);
      return result.ok;
    } catch (error: unknown) {
      console.warn("[desktop-link] enable failed", error instanceof Error ? error.name : "unknown_error");
      setFailure("unavailable");
      return false;
    } finally {
      setBusySlot(null);
    }
  }, []);

  const disable = useCallback(async (slot: string): Promise<void> => {
    setBusySlot(slot);
    try {
      await invoke("desktop-link:disable", { slot });
    } catch (error: unknown) {
      // Main closes the link before it answers; a failed answer changes nothing shown.
      console.warn("[desktop-link] disable failed", error instanceof Error ? error.name : "unknown_error");
    } finally {
      setBusySlot(null);
    }
  }, []);

  return { computers, busySlot, failure, clearFailure: () => setFailure(null), enable, disable };
}

export type DesktopLinkView = ReturnType<typeof useDesktopLink>;
