import { useOnboardingSupportDock as useSharedSupportDock, type OnboardingSupportDockInput } from "@matrix-os/ui";
import { useUi } from "../../stores/ui";

export function useOnboardingSupportDock(input: Omit<OnboardingSupportDockInput, "supportOpen">): void {
  const supportOpen = useUi((state) => state.supportPanelOpen);
  useSharedSupportDock({ ...input, supportOpen });
}
