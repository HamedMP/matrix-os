import {
  ChefHatIcon,
  Target02Icon,
  UserGroupIcon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { GET_STARTED_APP_IDEAS, type GetStartedAppIdeaId, type GetStartedWizardEvent, type GetStartedWizardState } from "@matrix-os/contracts";
import { Icon } from "../onboarding-widget/parts.js";

const IDEA_ICONS: Record<GetStartedAppIdeaId, IconSvgElement> = {
  "habit-tracker": Target02Icon,
  "client-crm": UserGroupIcon,
  "budget-planner": Wallet01Icon,
  "recipe-box": ChefHatIcon,
};

/**
 * Spec 635: App Gallery between the main bot and the assistant bots. Shows what owners can
 * build; a pick is only an answer, and Matrix offers to build it once they arrive.
 */
export function GetStartedAppGalleryStep({ wizard, dispatch, labelledBy }: {
  wizard: GetStartedWizardState;
  dispatch(event: GetStartedWizardEvent): void;
  labelledBy: string;
}) {
  return (
    <div className="mxo-gs__gallery">
      <div className="mxo-gs__ideas" role="group" aria-labelledby={labelledBy}>
        {GET_STARTED_APP_IDEAS.map((idea) => (
          <button
            key={idea.id}
            type="button"
            className="mxo-card mxo-gs__idea"
            aria-pressed={wizard.appIdea === idea.id}
            onClick={() => dispatch({ type: "pick-app-idea", id: idea.id })}
          >
            <span className="mxo-gs__idea-icon"><Icon icon={IDEA_ICONS[idea.id]} size={18} /></span>
            <strong>{idea.label}</strong>
            <span className="mxo-muted">{idea.request}</span>
          </button>
        ))}
      </div>
      <p className="mxo-muted">Matrix offers to build your pick when you arrive. Make anything else in App Gallery anytime.</p>
    </div>
  );
}
