import { useOtaUpdatePrompt } from "@/lib/use-ota-update-prompt";

// A leaf of its own so update download progress re-renders only this component,
// not the whole shell.
export function OtaUpdatePrompt() {
  useOtaUpdatePrompt();
  return null;
}
