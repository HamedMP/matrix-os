// Whether the computer this device is paired with may use it (spec 2716), as
// main reports it. The renderer never holds a key, bearer or link; it asks main
// to pair (2698's native dialog), switch the link on or off, and shows what main says.
import { useCallback, useEffect, useState } from "react";
import { z } from "zod/v4";
import { DesktopLinkStatusSchema, type DesktopLinkStatusEntry } from "../../../../shared/desktop-link";
import { invoke, onEvent } from "../../lib/operator";

export type DesktopLinkEnableFailure = "denied" | "not_paired" | "unavailable";

export const DESKTOP_LINK_ENABLE_FAILURE: Record<DesktopLinkEnableFailure, string> = {
  denied: "Only your primary computer can use this device.",
  not_paired: "This device isn't paired with your computer any more. Pair it again.",
  unavailable: "Couldn't reach your computer. Try again.",
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

  const [pairing, setPairing] = useState(false);
  /** Opens 2698's pairing dialog in main; pairing there turns the link on. */
  const pair = useCallback(async (): Promise<void> => {
    setPairing(true);
    setFailure(null);
    try {
      await invoke("desktop-link:pair", {});
    } catch (error: unknown) {
      console.warn("[desktop-link] pairing failed", error instanceof Error ? error.name : "unknown_error");
      setFailure("unavailable");
    } finally {
      setPairing(false);
    }
  }, []);

  return { computers, busySlot, failure, pairing, clearFailure: () => setFailure(null), enable, disable, pair };
}

export type DesktopLinkView = ReturnType<typeof useDesktopLink>;
